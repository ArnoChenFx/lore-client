import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  isAuthenticationRequiredError,
  listAuthIdentities,
  listRemoteRepositories,
  loadRepositorySnapshot,
  loginAuthInteractive,
  refreshRepositoryAuthenticationContexts,
  subscribeRemoteAuthenticationRequired
} from '../../services/lore'
import { readErrorMessage } from '../../shared/lib'
import type { ApplicationMode, Repository, RepositorySnapshot } from '../../types'

export interface RemoteAuthenticationTarget {
  serverUrl: string
  repositoryNames: string[]
}

export interface AuthenticationRefreshResult {
  snapshots: RepositorySnapshot[]
  failedCount: number
}

interface AuthenticationRefreshDependencies {
  refreshContexts: (repositoryPaths: string[]) => Promise<void>
  loadSnapshot: (repositoryPath: string, includeChanges: boolean) => Promise<RepositorySnapshot>
}

interface UseRemoteAuthenticationRecoveryOptions {
  applicationMode: ApplicationMode
  snapshots: RepositorySnapshot[]
  upsertSnapshot: (snapshot: RepositorySnapshot) => void
  onEnterOfflineMode: () => void
  /**
   * 可注入的跨模块服务依赖；生产使用默认真实实现。
   *
   * Bun test 的模块级 vi.mock 会在部分平台上泄漏到其他测试文件，因此
   * Hook 测试必须通过此契约注入替身，而不是替换整个 services 模块。
   */
  dependencies?: Partial<{
    isAuthenticationRequiredError: typeof isAuthenticationRequiredError
    listAuthIdentities: typeof listAuthIdentities
    listRemoteRepositories: typeof listRemoteRepositories
    loadRepositorySnapshot: typeof loadRepositorySnapshot
    loginAuthInteractive: typeof loginAuthInteractive
    refreshRepositoryAuthenticationContexts: typeof refreshRepositoryAuthenticationContexts
    subscribeRemoteAuthenticationRequired: typeof subscribeRemoteAuthenticationRequired
    confirmAuthenticationRequiredServers: typeof confirmAuthenticationRequiredServers
  }>
}

/**
 * 统一得到远端服务器根地址。
 *
 * 新快照应始终携带 `serverUrl`；正则回退只服务于旧快照或迁移中的 DTO，避免把
 * 带仓库名的完整远端地址误当成另一台服务器。
 */
export function repositoryServerUrl(repository: Pick<Repository, 'remoteUrl' | 'serverUrl'>): string {
  if (repository.serverUrl?.trim()) return repository.serverUrl.trim()
  const remoteUrl = repository.remoteUrl?.trim() ?? ''
  return remoteUrl.match(/^([a-z][a-z0-9+.-]*:\/\/[^/]+)/i)?.[1] ?? remoteUrl
}

/** 服务器键只用于当前会话去重，不改变传给 Lore 的原始 URL。 */
export function remoteServerKey(serverUrl: string): string {
  return serverUrl.trim().replace(/\/+$/, '').toLocaleLowerCase()
}

/** 按服务器聚合需要认证的仓库，避免同一凭据失效时连续弹出多个对话框。 */
export function collectRemoteAuthenticationTargets(
  snapshots: RepositorySnapshot[],
  pausedServerKeys: ReadonlySet<string>
): RemoteAuthenticationTarget[] {
  const targets = new Map<string, RemoteAuthenticationTarget>()
  for (const snapshot of snapshots) {
    if (snapshot.repository.remoteState !== 'unauthorized') continue
    const serverUrl = repositoryServerUrl(snapshot.repository)
    const key = remoteServerKey(serverUrl)
    if (!key || pausedServerKeys.has(key)) continue
    const target = targets.get(key) ?? { serverUrl, repositoryNames: [] }
    if (!target.repositoryNames.includes(snapshot.repository.name)) {
      target.repositoryNames.push(snapshot.repository.name)
    }
    targets.set(key, target)
  }
  return [...targets.values()]
}

/**
 * 收集需要认证探测的候选服务器。
 *
 * Lore 0.9.0 在凭据缺失时 Status 只返回 remoteAvailable=0，快照会被判定为
 * offline 而不是 unauthorized，因此自动弹窗检测器拿不到证据。收到 Rust 的
 * 全局失效信号后，改用对已打开远端仓库的服务器做真实连接探测来确认；本地
 * 仓库、无远端地址和用户已选择离线的服务器都被排除。
 */
export function collectAuthenticationProbeServers(
  snapshots: RepositorySnapshot[],
  pausedServerKeys: ReadonlySet<string>
): string[] {
  const servers = new Set<string>()
  for (const snapshot of snapshots) {
    const { remoteState } = snapshot.repository
    if (remoteState === 'local' || remoteState === 'online') continue
    const serverUrl = repositoryServerUrl(snapshot.repository)
    const key = remoteServerKey(serverUrl)
    if (!key || pausedServerKeys.has(key)) continue
    servers.add(serverUrl)
  }
  return [...servers]
}

/**
 * 对候选服务器逐一探测，返回确认“凭据失效”的服务器。
 *
 * 探测是只读的服务器目录列表：认证失效返回稳定 `auth_required`，在线且授权
 * 返回成功；网络不可达等其他失败保持静默，不把真离线误报成需要重新登录。
 */
export async function confirmAuthenticationRequiredServers(
  servers: string[],
  probe: (serverUrl: string) => Promise<unknown>
): Promise<string[]> {
  const results = await Promise.allSettled(
    servers.map((serverUrl) => probe(serverUrl).then(() => null))
  )
  return servers.filter((_, index) => {
    const result = results[index]
    return result.status === 'rejected' && isAuthenticationRequiredError(result.reason)
  })
}

/**
 * 用户主动跳过认证后只改变当前会话的展示与联网策略。
 *
 * 原始快照仍保留 `unauthorized` 证据，便于显式重试时恢复；返回的新对象只让所有
 * 消费 UI 统一显示离线，并阻止状态栏、标题栏和工具栏出现彼此矛盾的认证状态。
 */
export function projectPausedRepositoriesOffline(
  snapshots: RepositorySnapshot[],
  pausedServerKeys: ReadonlySet<string>
): RepositorySnapshot[] {
  return snapshots.map((snapshot) => {
    const key = remoteServerKey(repositoryServerUrl(snapshot.repository))
    if (!key || !pausedServerKeys.has(key) || snapshot.repository.remoteState === 'local') return snapshot
    return {
      ...snapshot,
      repository: {
        ...snapshot.repository,
        online: false,
        remoteState: 'offline'
      }
    }
  })
}

/**
 * 认证变化后的原子刷新顺序：先失效所有原生上下文，再读取并发布每个仓库的新快照。
 *
 * 依赖参数只用于单元测试验证跨 IPC 顺序；生产调用始终使用 Lore 服务层实现。某个
 * Context 释放失败时 Rust 已继续尝试其他仓库，因此这里仍读取全部快照，不让一个
 * 损坏或已删除的仓库阻塞其他 Tab 恢复。
 */
export async function refreshRepositoryAuthenticationState(
  snapshots: RepositorySnapshot[],
  upsertSnapshot: (snapshot: RepositorySnapshot) => void,
  dependencies: AuthenticationRefreshDependencies = {
    refreshContexts: refreshRepositoryAuthenticationContexts,
    loadSnapshot: loadRepositorySnapshot
  }
): Promise<AuthenticationRefreshResult> {
  try {
    await dependencies.refreshContexts(snapshots.map((snapshot) => snapshot.repository.path))
  } catch {
    // 继续读取真实 Status，由各仓库的新快照明确呈现仍未恢复的状态。
  }
  const results = await Promise.allSettled(
    snapshots.map((snapshot) => dependencies.loadSnapshot(snapshot.repository.path, false))
  )
  const refreshedSnapshots: RepositorySnapshot[] = []
  let failedCount = 0
  for (const result of results) {
    if (result.status === 'fulfilled') {
      refreshedSnapshots.push(result.value)
      upsertSnapshot(result.value)
    } else {
      failedCount += 1
    }
  }
  return { snapshots: refreshedSnapshots, failedCount }
}

/**
 * 编排远端认证恢复与会话级离线降级。
 *
 * Token 始终由 Lore Token Store 管理；本 Hook 只保存服务器键、忙碌状态和错误文本。
 * 认证或账户绑定改变后会重读所有相关仓库快照，保证标题栏、状态栏、工具栏、账户页
 * 与后台通知订阅都消费同一份真实连接状态。
 */
export function useRemoteAuthenticationRecovery({
  applicationMode,
  snapshots,
  upsertSnapshot,
  onEnterOfflineMode,
  dependencies
}: UseRemoteAuthenticationRecoveryOptions) {
  // 解构到稳定名：生产时是模块级真实实现，测试注入替身后引用保持不变。
  const {
    isAuthenticationRequiredError: confirmsAuthenticationRequired = isAuthenticationRequiredError,
    listAuthIdentities: listIdentities = listAuthIdentities,
    listRemoteRepositories: listRemote = listRemoteRepositories,
    loadRepositorySnapshot: loadSnapshot = loadRepositorySnapshot,
    loginAuthInteractive: loginInteractive = loginAuthInteractive,
    refreshRepositoryAuthenticationContexts: refreshContexts = refreshRepositoryAuthenticationContexts,
    subscribeRemoteAuthenticationRequired: subscribeAuthRequired = subscribeRemoteAuthenticationRequired,
    confirmAuthenticationRequiredServers: confirmServers = confirmAuthenticationRequiredServers
  } = dependencies ?? {}
  const [pausedServerKeys, setPausedServerKeys] = useState<Set<string>>(() => new Set())
  const [requestedTarget, setRequestedTarget] = useState<RemoteAuthenticationTarget | null>(null)
  const [authenticationBusy, setAuthenticationBusy] = useState(false)
  const [authenticationError, setAuthenticationError] = useState<string | null>(null)
  const [authStateVersion, setAuthStateVersion] = useState(0)

  const detectedTargets = useMemo(
    () => collectRemoteAuthenticationTargets(snapshots, pausedServerKeys),
    [pausedServerKeys, snapshots]
  )
  const requestedKey = requestedTarget ? remoteServerKey(requestedTarget.serverUrl) : ''
  const authenticationTarget =
    requestedTarget && !pausedServerKeys.has(requestedKey) ? requestedTarget : (detectedTargets[0] ?? null)

  const refreshAuthenticationState = useCallback(
    async (serverUrl?: string): Promise<AuthenticationRefreshResult> => {
      const requestedServerKey = serverUrl ? remoteServerKey(serverUrl) : ''
      const relevantSnapshots = snapshots.filter((snapshot) => {
        const key = remoteServerKey(repositoryServerUrl(snapshot.repository))
        return key && (!requestedServerKey || key === requestedServerKey)
      })
      const refreshed = await refreshRepositoryAuthenticationState(relevantSnapshots, upsertSnapshot, {
        refreshContexts,
        loadSnapshot
      })
      /*
       * 版本号必须在原生上下文失效与快照重读之后再推进，避免账户页、服务器目录和
       * 仓库工具在同一时刻抢先读取旧上下文。
       */
      setAuthStateVersion((current) => current + 1)
      /*
       * 离线暂停必须最后解除。账户页登录可能需要等待原生连接释放和 Status 重读；若在
       * 等待期间先暴露旧 unauthorized 快照，全局检测器会误判为新的失效并再次弹窗。
       * React 会把已发布的新快照与这里的暂停更新一起提交，因此有效登录直接恢复在线；
       * 新快照仍未授权时则会在验证完成后正常进入恢复流程。
       */
      setPausedServerKeys((current) => {
        if (current.size === 0) return current
        const next = new Set(current)
        if (requestedServerKey) next.delete(requestedServerKey)
        else next.clear()
        return next
      })
      return refreshed
    },
    [snapshots, upsertSnapshot, refreshContexts, loadSnapshot]
  )

  /** 服务器目录等无本地仓库入口也可以显式请求同一个全局认证对话框。 */
  const requestAuthentication = useCallback((serverUrl: string) => {
    const normalizedUrl = serverUrl.trim()
    if (!normalizedUrl) return
    const key = remoteServerKey(normalizedUrl)
    setPausedServerKeys((current) => {
      if (!current.has(key)) return current
      const next = new Set(current)
      next.delete(key)
      return next
    })
    setAuthenticationError(null)
    setRequestedTarget({ serverUrl: normalizedUrl, repositoryNames: [] })
  }, [])

  const authenticate = useCallback(async () => {
    if (applicationMode !== 'tauri' || !authenticationTarget || authenticationBusy) return
    const target = authenticationTarget
    try {
      setAuthenticationBusy(true)
      setAuthenticationError(null)
      await loginInteractive(target.serverUrl)
      /*
       * Auth List 的结果用于推动账户中心刷新；远端是否真正恢复则必须以各仓库 Status
       * 为准。显示名解析失败不会影响这里的连接验证。
       */
      await listIdentities()
      const refreshed = await refreshAuthenticationState(target.serverUrl)
      if (refreshed.snapshots.some((snapshot) => snapshot.repository.remoteState === 'unauthorized')) {
        setAuthenticationError('authentication_still_required')
        return
      }
      if (target.repositoryNames.length > 0 && refreshed.snapshots.length === 0 && refreshed.failedCount > 0) {
        setAuthenticationError('authentication_verification_failed')
        return
      }
      setRequestedTarget((current) =>
        current && remoteServerKey(current.serverUrl) === remoteServerKey(target.serverUrl) ? null : current
      )
    } catch (error) {
      setAuthenticationError(readErrorMessage(error))
    } finally {
      setAuthenticationBusy(false)
    }
  }, [
    applicationMode,
    authenticationBusy,
    authenticationTarget,
    refreshAuthenticationState,
    loginInteractive,
    listIdentities
  ])

  const continueOffline = useCallback(() => {
    if (!authenticationTarget || authenticationBusy) return
    const key = remoteServerKey(authenticationTarget.serverUrl)
    setPausedServerKeys((current) => new Set(current).add(key))
    setRequestedTarget((current) => (current && remoteServerKey(current.serverUrl) === key ? null : current))
    setAuthenticationError(null)
    onEnterOfflineMode()
  }, [authenticationBusy, authenticationTarget, onEnterOfflineMode])

  /*
   * 快照与暂停状态在探测时必须是最新的；订阅本身只随应用模式注册一次，
   * 用 ref 在渲染提交后同步最新值，避免快照刷新反复拆卸重挂全局监听。
   */
  const probeInputsRef = useRef({ applicationMode, snapshots, pausedServerKeys, requestedTarget })
  useEffect(() => {
    probeInputsRef.current = { applicationMode, snapshots, pausedServerKeys, requestedTarget }
  })

  useEffect(() => {
    if (applicationMode !== 'tauri') return undefined
    let disposed = false
    let lastHandledAtMs = 0
    let unlisten: (() => void) | null = null
    void subscribeAuthRequired((event) => {
      if (disposed) return
      /*
       * 凭据失效会让多个命令在几百毫秒内连续失败；Rust 已做 3 秒节流，
       * 这里再收敛一次，保证一次信号只触发一轮探测与弹窗。
       */
      const nowMs = Date.now()
      if (nowMs - lastHandledAtMs < 1_500) return
      lastHandledAtMs = nowMs
      const inputs = probeInputsRef.current
      if (inputs.applicationMode !== 'tauri') return
      /*
       * 恢复对话框已经针对某台服务器打开时无需重复探测；新一轮信号只服务
       * 尚未弹窗的会话，避免认证流程进行中的噪音探测。
       */
      if (inputs.requestedTarget) return
      const servers = collectAuthenticationProbeServers(
        inputs.snapshots,
        inputs.pausedServerKeys
      )
      if (servers.length === 0) return
      void confirmServers(servers, (serverUrl) =>
        listRemote(serverUrl)
      ).then((confirmed) => {
        if (disposed || confirmed.length === 0) return
        requestAuthentication(confirmed[0])
      })
    }).then((dispose) => {
      if (disposed) {
        dispose()
        return
      }
      unlisten = dispose
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [applicationMode, requestAuthentication, subscribeAuthRequired, listRemote, confirmServers])

  const projectedSnapshots = useMemo(
    () => projectPausedRepositoriesOffline(snapshots, pausedServerKeys),
    [pausedServerKeys, snapshots]
  )

  const isRepositoryNetworkPaused = useCallback(
    (repository: Pick<Repository, 'remoteUrl' | 'serverUrl'>) =>
      pausedServerKeys.has(remoteServerKey(repositoryServerUrl(repository))),
    [pausedServerKeys]
  )

  return {
    snapshots: projectedSnapshots,
    authenticationTarget,
    authenticationBusy,
    authenticationError,
    authStateVersion,
    authenticate,
    continueOffline,
    requestAuthentication,
    refreshAuthenticationState,
    isRepositoryNetworkPaused
  }
}
