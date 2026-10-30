import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { confirmLocalized, t } from '../../i18n'
import {
  acquireFileLocks,
  addFileDependency,
  addLayer,
  addLink,
  amendCurrentRevision,
  applyRepositoryView,
  bisectRevisionRange,
  clearAuthIdentities,
  collectRepositoryGarbage,
  dumpRepositoryState,
  findRevisionByMetadata,
  findRevisionByNumber,
  listAuthIdentities,
  listLayers,
  listLinks,
  listRemoteRepositories,
  listRepositoryInstances,
  loadBranchCollaboration,
  loadBranchDiff,
  loadFileDependencyGraph,
  loadFileLockStatus,
  loadLinkInfo,
  loadMetadata,
  loadRepositoryView,
  loadRevisionInfo,
  loginAuthInteractive,
  loginAuthWithToken,
  logoutAuthIdentity,
  previewRepositoryView,
  pruneRepositoryInstances,
  publishRepository,
  LoreRepositoryPublishError,
  queryFileLocks,
  releaseFileLocks,
  removeFileDependency,
  removeLayer,
  removeLink,
  resetBranchLatest,
  restoreCurrentRevision,
  setRepositoryAuthAccountBinding,
  setBranchProtected,
  syncRepository,
  updateLink,
  updateRepositoryConfig,
  updateRepositoryInstancePath,
  verifyRepository,
  verifyRepositoryFragment,
  verifyRepositoryPath
} from '../../services/lore'
import { createOperationContext, withOperationRequest } from '../../services/operationRequests'
import { changeFilePath, LatestTaskQueue, readErrorMessage, repositoryPathKey } from '../../shared/lib'
import type {
  ApplicationMode,
  OperationContext,
  LoreDependencyGraphQuery,
  LoreDependencySelection,
  LoreDiagnosticReport,
  LoreFileLock,
  LoreAuthIdentity,
  LoreLayer,
  LoreLayerAddRequest,
  LoreLayerRemoveRequest,
  LoreLink,
  LoreLinkAddRequest,
  LoreLinkDetails,
  LoreLinkUpdateRequest,
  RepositoryAuthAccountBinding,
  RepositoryConfiguration,
  RepositorySnapshot,
  RemoteRepository,
  RepositoryView,
  RepositoryViewPreview,
  ToastMessage
} from '../../types'
import { operationMessage } from '../operations'
import type {
  RepositoryMutationRunner,
  RepositoryToolTab,
  RepositoryToolsController,
  RepositoryToolsDialogProps
} from './types'

/** Logout may remove local credentials before remote revocation fails. Refresh
 * account and repository state while preserving the original operation error. */
export async function runAuthenticationMutation(
  action: () => Promise<unknown>,
  refresh: () => Promise<unknown>,
  refreshOnFailure = false
): Promise<void> {
  try {
    await action()
  } catch (error) {
    if (refreshOnFailure) await refresh().catch(() => undefined)
    throw error
  }
  await refresh()
}

interface RepositoryToolSession {
  readonly repositoryPath: string
  readonly tab: RepositoryToolTab
}

const REPOSITORY_TOOL_BUSY_ACTIONS = new Set([
  'updateRepositoryConfiguration',
  'publishRepository',
  'pushBranch',
  'verifyRepository',
  'collectStorage',
  'applyRepositoryView',
  'addLayer',
  'removeLayer',
  'addLink',
  'updateLinkPin',
  'removeLink',
  'addFileDependency',
  'removeFileDependency',
  'dependencyDrivenSync',
  'protectBranch',
  'unprotectBranch',
  'resetBranchLatest',
  'amendRevision',
  'bisectRevision',
  'restoreRevision',
  'loginAuthInteractive',
  'loginAuthWithToken',
  'logoutAuthIdentity',
  'clearAuthIdentities',
  'healRepository',
  'pruneRepositoryInstances',
  'updateRepositoryInstancePath'
])

/** 只把真正阻塞 Repository Tools 的仓库写操作映射为弹层加载态。 */
export function isRepositoryToolsBusy(busyAction: string | null): boolean {
  return busyAction !== null && REPOSITORY_TOOL_BUSY_ACTIONS.has(busyAction)
}

/** 文件菜单去除完全重复及空字符串，保留真实文件名中的空格。 */
export function normalizeRepositoryToolPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((path) => path.length > 0))]
}

/**
 * 原生配置更新会在原子替换后重新读取并返回两个白名单字段，因此结果本身就是权威
 * 状态。仅投影 Repository 配置可避免再次串行读取 Status、Branch、History、Auth
 * 作者和标签；其余会话数据保持同一引用，不伪造任何工作区状态。
 */
export function projectRepositoryConfigurationSnapshot(
  activeSnapshot: RepositorySnapshot,
  configuration: RepositoryConfiguration
): RepositorySnapshot {
  return {
    ...activeSnapshot,
    repository: {
      ...activeSnapshot.repository,
      identity: configuration.identity,
      remoteUrl: configuration.remoteUrl,
      // 配置页只接受服务器根地址，因此 serverUrl 与规范化后的 remoteUrl 相同。
      serverUrl: configuration.remoteUrl
    },
    loadedAt: new Date().toISOString()
  }
}

type DependencyGraphLoader = (
  repositoryPath: string,
  rootPaths: string[],
  options: LoreDependencySelection,
  reverse: boolean,
  revision?: string
) => Promise<LoreDependencyGraphQuery>

/**
 * 加载当前工作区的依赖图。
 *
 * 单独保留这个编排边界，使“新增依赖后立即查询”的 Revision 选择可以被回归测试覆盖，
 * 而无需在测试中挂载包含大量仓库工具状态的完整 React 控制器。
 */
export async function loadCurrentDependencyGraph(
  repositoryPath: string,
  rootPaths: string[],
  options: LoreDependencySelection,
  reverse: boolean,
  currentRevision: string,
  loader: DependencyGraphLoader = loadFileDependencyGraph
): Promise<LoreDependencyGraphQuery> {
  /*
   * dependency-add / dependency-remove 会把元数据写入 staged anchor，而显式传入当前
   * Revision 会绕过该暂存状态并读取旧快照。这里故意省略 Revision，让 Lore 按
   * “staged anchor > current anchor”解析；返回 DTO 仍使用当前 Revision 标识其基线，
   * 避免图谱标题因为协议未回传 staged signature 而出现空白。
   */
  const result = await loader(repositoryPath, rootPaths, options, reverse, undefined)
  return result.revision ? result : { ...result, revision: currentRevision }
}

/**
 * 从服务器目录定位当前本地仓库连接的远端对象。
 *
 * Repository ID 是首选稳定标识；名称只用于兼容旧仓库或异常服务器未返回一致 ID
 * 的场景，且不会从本地路径或 URL 文本猜测新的远端名称。
 */
export function findConnectedRemoteRepository(
  repositories: readonly RemoteRepository[],
  repositoryId: string,
  repositoryName: string
): RemoteRepository | undefined {
  return (
    repositories.find((repository) => repository.id === repositoryId) ??
    repositories.find((repository) => repository.name === repositoryName)
  )
}

export interface ResolvedPublishAuthAccount {
  authUrl: string
  userId: string
  /** `true` 表示没有仓库绑定，但设备上只有一个账户，可以安全地自动绑定。 */
  inferred: boolean
}

/** 仅识别远端尚未创建时返回的稳定认证错误，避免对权限或重名失败盲目重试。 */
export function isPublishAuthenticationError(error: unknown): boolean {
  return error instanceof LoreRepositoryPublishError && error.result.failureCode === 'auth_required'
}

/**
 * 为发布操作解析确定的认证账户。
 *
 * 仓库绑定优先于设备账户列表；只有设备上恰好一个账户时才允许自动选择，避免多账户
 * 环境把远端仓库创建到错误身份下。没有唯一答案时由调用方提示用户前往账户页绑定。
 */
export function resolvePublishAuthAccount(
  repositoryPath: string,
  bindings: readonly RepositoryAuthAccountBinding[],
  identities: readonly LoreAuthIdentity[]
): ResolvedPublishAuthAccount | null {
  const binding = bindings.find(
    (candidate) =>
      repositoryPathKey(candidate.repositoryPath) === repositoryPathKey(repositoryPath) &&
      candidate.userId.trim().length > 0
  )
  if (binding) {
    return {
      authUrl: binding.authUrl,
      userId: binding.userId.trim(),
      inferred: false
    }
  }

  /*
   * Auth List 可能为同一用户返回身份根条目和多个资源授权条目。自动选择按 userId
   * 去重，不能把同一账户的多条资源记录误判成多账户歧义。
   */
  const uniqueIdentities = [
    ...new Map(
      identities
        .filter((identity) => identity.userId.trim().length > 0)
        .map((identity) => [identity.userId.trim(), identity] as const)
    ).values()
  ]
  if (uniqueIdentities.length !== 1) {
    return null
  }
  return {
    authUrl: uniqueIdentities[0]!.authUrl,
    userId: uniqueIdentities[0]!.userId.trim(),
    inferred: true
  }
}

type Notify = (title: string, detail: string, tone?: ToastMessage['tone']) => void

interface UseRepositoryToolsControllerOptions {
  applicationMode: ApplicationMode
  activeSnapshot?: RepositorySnapshot
  repositorySnapshots: RepositorySnapshot[]
  authAccountBindings: RepositoryAuthAccountBinding[]
  onAuthAccountBindingsChange: (bindings: RepositoryAuthAccountBinding[]) => void
  authStateVersion: number
  onAuthenticationRequired: (serverUrl: string) => void
  onAuthStateChange: (serverUrl?: string, context?: OperationContext) => Promise<unknown>
  defaultIdentity: string
  busyAction: string | null
  initialDependencyQuery?: LoreDependencyGraphQuery | null
  notify: Notify
  openRepository: () => Promise<unknown>
  runRepositoryMutation: RepositoryMutationRunner
  upsertSnapshot: (snapshot: RepositorySnapshot) => void
  pushCurrentRepository: () => Promise<unknown>
  locateRevision: (revision: string) => void
}

/**
 * Repository Tools 的领域控制器。
 *
 * 控制器拥有页签资源、惰性读取、写操作和对话框契约；App 仅负责提供统一仓库写入入口
 * 与少量跨领域导航。所有真实 Lore 调用仍经过 `services/lore/`，组件不接触 IPC。
 */
export function useRepositoryToolsController({
  applicationMode,
  activeSnapshot,
  repositorySnapshots,
  authAccountBindings,
  onAuthAccountBindingsChange,
  authStateVersion,
  onAuthenticationRequired,
  onAuthStateChange,
  defaultIdentity,
  busyAction,
  initialDependencyQuery = null,
  notify,
  openRepository,
  runRepositoryMutation,
  upsertSnapshot,
  pushCurrentRepository,
  locateRevision
}: UseRepositoryToolsControllerOptions): RepositoryToolsController {
  const [toolSession, setToolSession] = useState<RepositoryToolSession | null>(null)
  const tab = toolSession?.tab ?? null
  const toolSessionRef = useRef<RepositoryToolSession | null>(null)
  const resourcesActiveRef = useRef(true)
  const [layers, setLayers] = useState<LoreLayer[]>([])
  const [links, setLinks] = useState<LoreLink[]>([])
  const [fileLocks, setFileLocks] = useState<LoreFileLock[]>([])
  const [fileLockState, setFileLockState] = useState<'loading' | 'ready' | 'unavailable'>(
    applicationMode === 'tauri' ? 'loading' : 'unavailable'
  )
  const [dependencyQuery, setDependencyQuery] = useState<LoreDependencyGraphQuery | null>(initialDependencyQuery)
  const [repositoryView, setRepositoryView] = useState<RepositoryView | null>(null)
  const [connectedRemoteDescription, setConnectedRemoteDescription] = useState('')
  const [connectedRemoteName, setConnectedRemoteName] = useState('')
  const [publishAuthIdentities, setPublishAuthIdentities] = useState<LoreAuthIdentity[]>([])
  const [loading, setLoading] = useState(false)
  const [authActionsPending, setAuthActionsPending] = useState(0)
  const resourceRequestCounter = useRef(0)
  const lockRequestCounter = useRef(0)
  const fileLockStatusQueue = useRef(new LatestTaskQueue())
  const resourceRepositoryPathRef = useRef(activeSnapshot?.repository.path ?? '')
  const lockRepositoryRef = useRef(activeSnapshot?.repository)

  useEffect(() => {
    const queue = fileLockStatusQueue.current
    queue.activate()
    resourcesActiveRef.current = true
    return () => {
      queue.dispose()
      resourcesActiveRef.current = false
      resourceRequestCounter.current += 1
      lockRequestCounter.current += 1
    }
  }, [])

  useEffect(() => {
    lockRepositoryRef.current = activeSnapshot?.repository
  }, [activeSnapshot])

  // 页签重开使用新的对象身份；即使路径相同，旧表单回调也不能重新取得提交权。
  const isToolSessionCurrent = useCallback(
    (session: RepositoryToolSession | null): session is RepositoryToolSession =>
      session !== null &&
      resourcesActiveRef.current &&
      toolSessionRef.current === session &&
      resourceRepositoryPathRef.current === session.repositoryPath,
    []
  )

  const releaseRepositoryToolResources = useCallback(() => {
    /*
     * 这些数组和图只服务当前打开的工具页，不属于仓库会话快照。关闭工具或切换
     * Repository 后立即断开引用，避免完整 Layer、Link、依赖图和 View 规则被隐藏
     * 在 React 状态中长期保留。
     */
    setLayers([])
    setLinks([])
    setDependencyQuery(null)
    setRepositoryView(null)
    setConnectedRemoteDescription('')
    setConnectedRemoteName('')
    setPublishAuthIdentities([])
  }, [])

  /** 锁属于当前工作区路径和分支，独立于工具页开关；旧写操作不能为新工作区发起刷新。 */
  const loadLocks = useCallback(
    async (paths?: string[]): Promise<LoreFileLock[]> => {
      const isCurrentWorkspace = () =>
        resourcesActiveRef.current &&
        lockRepositoryRef.current?.path === activeSnapshot?.repository.path &&
        lockRepositoryRef.current?.branch === activeSnapshot?.repository.branch
      if (!isCurrentWorkspace()) return []
      if (!activeSnapshot || applicationMode !== 'tauri') {
        setFileLocks([])
        setFileLockState('unavailable')
        return []
      }
      const requestId = ++lockRequestCounter.current
      setFileLockState('loading')
      try {
        const result = paths
          ? await fileLockStatusQueue.current.run(() =>
              loadFileLockStatus(
                activeSnapshot.repository.path,
                activeSnapshot.repository.branch,
                normalizeRepositoryToolPaths(paths)
              )
            )
          : await queryFileLocks(activeSnapshot.repository.path, activeSnapshot.repository.branch)
        if (isCurrentWorkspace() && requestId === lockRequestCounter.current) {
          setFileLocks(result)
          setFileLockState('ready')
        }
        return result
      } catch (error) {
        if (!isCurrentWorkspace() || requestId !== lockRequestCounter.current) return []
        setFileLocks([])
        setFileLockState('unavailable')
        throw error
      }
    },
    [activeSnapshot, applicationMode]
  )

  /**
   * 普通工作区只查询当前变更路径，避免每次快照刷新触发无界全仓 Lock Query。
   * 锁是附加协作信息，读取失败不能覆盖真实文件状态。
   */
  useEffect(() => {
    const requestId = ++lockRequestCounter.current
    queueMicrotask(() => {
      if (!resourcesActiveRef.current || requestId !== lockRequestCounter.current) return
      if (applicationMode !== 'tauri') {
        setFileLocks([])
        setFileLockState('unavailable')
        return
      }
      if (!activeSnapshot || activeSnapshot.changes.length === 0) {
        setFileLocks([])
        setFileLockState('ready')
        return
      }
      void loadLocks(activeSnapshot.changes.map(changeFilePath)).catch(() => {
        // 工作区刷新保持静默；菜单会通过 unavailable 状态给出明确不可用原因。
      })
    })
  }, [activeSnapshot, applicationMode, loadLocks])

  const close = useCallback(() => {
    resourceRequestCounter.current += 1
    toolSessionRef.current = null
    setToolSession(null)
    setLoading(false)
    releaseRepositoryToolResources()
  }, [releaseRepositoryToolResources])

  const open = useCallback(
    async (nextTab: RepositoryToolTab) => {
      if (!resourcesActiveRef.current) return
      if (!activeSnapshot && nextTab !== 'accounts') {
        await openRepository()
        return
      }

      const session: RepositoryToolSession = {
        repositoryPath: activeSnapshot?.repository.path ?? '',
        tab: nextTab
      }
      toolSessionRef.current = session
      setToolSession(session)
      const requestId = ++resourceRequestCounter.current
      setLoading(false)
      if (nextTab === 'accounts' || nextTab === 'maintenance' || applicationMode !== 'tauri') {
        return
      }
      if (!activeSnapshot) return

      if (nextTab === 'configuration') {
        setConnectedRemoteDescription('')
        setConnectedRemoteName('')
        setPublishAuthIdentities([])
      }

      try {
        setLoading(true)
        if (nextTab === 'configuration') {
          /*
           * 发布账户属于设备级资源，即使仓库尚未保存服务器地址也必须读取；这让用户
           * 可以先填写发布目标，再明确选择登录账户或留空进行匿名发布。
           */
          const identities = await listAuthIdentities().catch(() => [])
          if (isToolSessionCurrent(session) && requestId === resourceRequestCounter.current) {
            setPublishAuthIdentities(identities)
          }
          if (!isToolSessionCurrent(session) || !activeSnapshot.repository.serverUrl) {
            return
          }
          /*
           * 仓库配置只保存服务器根地址，远端名称不能从 URL 截取。先读取目录，再按
           * Repository ID 匹配同一仓库；已有账户绑定用于访问受保护服务器。
           */
          const account = resolvePublishAuthAccount(activeSnapshot.repository.path, authAccountBindings, identities)
          const repositories = await listRemoteRepositories(activeSnapshot.repository.serverUrl, account?.userId)
          const connectedRepository = findConnectedRemoteRepository(
            repositories,
            activeSnapshot.repository.id,
            activeSnapshot.repository.name
          )
          if (isToolSessionCurrent(session) && requestId === resourceRequestCounter.current) {
            setConnectedRemoteDescription(connectedRepository?.description ?? '')
            setConnectedRemoteName(connectedRepository?.name ?? '')
          }
        } else if (nextTab === 'view') {
          const result = await loadRepositoryView(activeSnapshot.repository.path)
          if (isToolSessionCurrent(session) && requestId === resourceRequestCounter.current) setRepositoryView(result)
        } else if (nextTab === 'layers') {
          const result = await listLayers(activeSnapshot.repository.path)
          if (isToolSessionCurrent(session) && requestId === resourceRequestCounter.current) setLayers(result)
        } else if (nextTab === 'locks') {
          await loadLocks()
        } else if (nextTab === 'dependencies') {
          /*
           * 依赖查询必须由明确根文件驱动。打开页签只清除上一仓库结果，
           * 不对大型仓库执行无界扫描。
           */
          if (isToolSessionCurrent(session) && requestId === resourceRequestCounter.current) setDependencyQuery(null)
        } else if (
          nextTab !== 'collaboration' &&
          nextTab !== 'revision' &&
          nextTab !== 'metadata' &&
          nextTab !== 'diagnostics'
        ) {
          const result = await listLinks(activeSnapshot.repository.path)
          if (isToolSessionCurrent(session) && requestId === resourceRequestCounter.current) setLinks(result)
        }
      } catch (error) {
        if (!isToolSessionCurrent(session) || requestId !== resourceRequestCounter.current) return
        if (nextTab === 'configuration') {
          /*
           * 远端说明只是发布表单的便利初值。离线、权限不足或服务器版本不兼容时
           * 保持空值即可，不能阻止用户编辑本地身份和服务器配置。
           */
          setConnectedRemoteDescription('')
          setConnectedRemoteName('')
          return
        }
        notify(
          t('status.failedToLoad', {
            name:
              nextTab === 'view'
                ? t('selectiveSyncView')
                : nextTab === 'layers'
                  ? t('layers')
                  : nextTab === 'locks'
                    ? t('collaborativeLocks')
                    : nextTab === 'dependencies'
                      ? t('fileDependencyGraph')
                      : nextTab === 'collaboration'
                        ? t('branchCollaboration')
                        : nextTab === 'revision'
                          ? t('revisionRecovery')
                          : t('links')
          }),
          readErrorMessage(error),
          'warning'
        )
      } finally {
        if (isToolSessionCurrent(session) && requestId === resourceRequestCounter.current) setLoading(false)
      }
    },
    [activeSnapshot, applicationMode, authAccountBindings, isToolSessionCurrent, loadLocks, notify, openRepository]
  )

  useEffect(() => {
    const repositoryPath = activeSnapshot?.repository.path ?? ''
    if (resourceRepositoryPathRef.current === repositoryPath) return

    resourceRepositoryPathRef.current = repositoryPath
    toolSessionRef.current = null
    const requestId = ++resourceRequestCounter.current

    // 只有最新仓库切换仍有权打开页签；关闭或再次切换会同步使本微任务失效。
    queueMicrotask(() => {
      if (requestId !== resourceRequestCounter.current) return
      setLoading(false)
      releaseRepositoryToolResources()
      if (tab && (activeSnapshot || tab === 'accounts')) void open(tab)
      else close()
    })
  }, [activeSnapshot, close, open, releaseRepositoryToolResources, tab])

  const setActiveBranchProtected = useCallback(
    async (branch: string, protectedValue: boolean) => {
      if (!confirmLocalized(t(protectedValue ? 'confirm.protectBranch' : 'confirm.unprotectBranch', { branch }))) {
        return false
      }
      return runRepositoryMutation(
        protectedValue ? 'protectBranch' : 'unprotectBranch',
        (repository, operationContext) => setBranchProtected(repository.path, branch, protectedValue, operationContext),
        operationMessage(protectedValue ? 'status.branchProtected' : 'status.branchUnprotected', { branch })
      )
    },
    [runRepositoryMutation]
  )

  const resetActiveBranchLatest = useCallback(
    async (
      branch: string,
      revision: string,
      expectedWorkspaceRevision: string,
      expectedLatest: string,
      skippedEntries: number
    ) => {
      if (
        !confirmLocalized(
          t('confirm.resetBranchLatest', {
            branch,
            revision: revision.slice(0, 12),
            latest: expectedLatest.slice(0, 12),
            count: skippedEntries
          })
        )
      ) {
        return false
      }
      return runRepositoryMutation(
        'resetBranchLatest',
        (repository, operationContext) =>
          resetBranchLatest(
            repository.path,
            branch,
            revision,
            expectedWorkspaceRevision,
            expectedLatest,
            operationContext
          ),
        operationMessage('status.branchLatestReset', {
          branch,
          revision: revision.slice(0, 12)
        })
      )
    },
    [runRepositoryMutation]
  )

  const amendActiveRevision = useCallback(
    async (message: string) => {
      if (!activeSnapshot) return false
      if (
        !confirmLocalized(
          t('confirm.amendRevision', {
            revision: activeSnapshot.repository.revision.slice(0, 12)
          })
        )
      ) {
        return false
      }
      return runRepositoryMutation(
        'amendRevision',
        (repository, operationContext) =>
          amendCurrentRevision(repository.path, repository.branch, repository.revision, message, operationContext),
        operationMessage('status.revisionAmended')
      )
    },
    [activeSnapshot, runRepositoryMutation]
  )

  const bisectActiveRevision = useCallback(
    async (start: string, end: string) => {
      if (!activeSnapshot) return false
      if (
        !confirmLocalized(
          t('confirm.bisectRevision', {
            start: start.slice(0, 12),
            end: end.slice(0, 12)
          })
        )
      ) {
        return false
      }
      return runRepositoryMutation(
        'bisectRevision',
        (repository, operationContext) =>
          bisectRevisionRange(repository.path, start, end, repository.revision, operationContext).then(
            ({ operation }) => operation
          ),
        operationMessage('status.bisectMidpointLoaded')
      )
    },
    [activeSnapshot, runRepositoryMutation]
  )

  const restoreActiveRevision = useCallback(
    async (message: string) => {
      if (!activeSnapshot) return false
      if (
        !confirmLocalized(
          t('confirm.restoreRevision', {
            revision: activeSnapshot.repository.revision.slice(0, 12),
            branch: activeSnapshot.repository.branch
          })
        )
      ) {
        return false
      }
      return runRepositoryMutation(
        'restoreRevision',
        (repository, operationContext) =>
          restoreCurrentRevision(repository.path, repository.revision, message, operationContext),
        operationMessage('status.revisionRestoredAsNew')
      )
    },
    [activeSnapshot, runRepositoryMutation]
  )

  const acquireActiveFileLocks = useCallback(
    async (paths: string[]) => {
      const uniquePaths = normalizeRepositoryToolPaths(paths)
      if (uniquePaths.length === 0) return false
      const succeeded = await runRepositoryMutation(
        'acquireCollaborativeLock',
        (repository, operationContext) =>
          acquireFileLocks(repository.path, repository.branch, uniquePaths, operationContext),
        uniquePaths.length === 1
          ? operationMessage('status.collaborativeLockAcquired', {
              path: uniquePaths[0]
            })
          : operationMessage('status.collaborativeLocksAcquired', {
              count: uniquePaths.length
            })
      )
      if (succeeded) {
        try {
          await loadLocks()
        } catch (error) {
          notify(t('failedToRefreshCollaborativeLocks'), readErrorMessage(error), 'warning')
        }
      }
      return succeeded
    },
    [loadLocks, notify, runRepositoryMutation]
  )

  const releaseActiveFileLocks = useCallback(
    async (paths: string[]) => {
      const uniquePaths = normalizeRepositoryToolPaths(paths)
      if (uniquePaths.length === 0) return false
      const succeeded = await runRepositoryMutation(
        'releaseCollaborativeLock',
        (repository, operationContext) =>
          releaseFileLocks(repository.path, repository.branch, uniquePaths, operationContext),
        uniquePaths.length === 1
          ? operationMessage('status.collaborativeLockReleased', {
              path: uniquePaths[0]
            })
          : operationMessage('status.collaborativeLocksReleased', {
              count: uniquePaths.length
            })
      )
      if (succeeded) {
        try {
          await loadLocks()
        } catch (error) {
          notify(t('failedToRefreshCollaborativeLocks'), readErrorMessage(error), 'warning')
        }
      }
      return succeeded
    },
    [loadLocks, notify, runRepositoryMutation]
  )

  const queryActiveDependencies = useCallback(
    async (
      paths: string[],
      options: LoreDependencySelection,
      reverse: boolean
    ): Promise<LoreDependencyGraphQuery | null> => {
      if (!activeSnapshot || applicationMode !== 'tauri' || !isToolSessionCurrent(toolSession)) return null
      const requestId = ++resourceRequestCounter.current
      const isCurrent = () => isToolSessionCurrent(toolSession) && requestId === resourceRequestCounter.current
      try {
        setLoading(true)
        const result = await loadCurrentDependencyGraph(
          activeSnapshot.repository.path,
          paths,
          options,
          reverse,
          activeSnapshot.repository.revision
        )
        if (!isCurrent()) return null
        setDependencyQuery(result)
        return result
      } catch (error) {
        if (isCurrent()) notify(t('dependencyQueryFailed'), readErrorMessage(error), 'warning')
        return null
      } finally {
        if (isCurrent()) setLoading(false)
      }
    },
    [activeSnapshot, applicationMode, isToolSessionCurrent, notify, toolSession]
  )

  const refreshCompositionResources = useCallback(
    async (kind: 'layers' | 'links', session: RepositoryToolSession | null) => {
      if (!isToolSessionCurrent(session)) return
      const requestId = ++resourceRequestCounter.current
      const isCurrent = () => isToolSessionCurrent(session) && requestId === resourceRequestCounter.current
      setLoading(true)
      try {
        if (kind === 'layers') {
          const result = await listLayers(session.repositoryPath)
          if (isCurrent()) setLayers(result)
        } else {
          const result = await listLinks(session.repositoryPath)
          if (isCurrent()) setLinks(result)
        }
      } catch (error) {
        if (!isCurrent()) return
        notify(
          t('status.failedToLoad', {
            name: kind === 'layers' ? t('layers') : t('links')
          }),
          readErrorMessage(error),
          'warning'
        )
      } finally {
        if (isCurrent()) setLoading(false)
      }
    },
    [isToolSessionCurrent, notify]
  )

  const addActiveLayer = useCallback(
    async (request: LoreLayerAddRequest): Promise<boolean> => {
      if (!activeSnapshot) return false
      const succeeded = await runRepositoryMutation(
        'addLayer',
        (repository, operationContext) => addLayer(repository.path, request, operationContext),
        operationMessage('status.layerAdded', { path: request.targetPath })
      )
      if (succeeded) await refreshCompositionResources('layers', toolSession)
      return succeeded
    },
    [activeSnapshot, refreshCompositionResources, runRepositoryMutation, toolSession]
  )

  const removeActiveLayer = useCallback(
    async (request: LoreLayerRemoveRequest): Promise<boolean> => {
      if (!activeSnapshot) return false
      const succeeded = await runRepositoryMutation(
        'removeLayer',
        (repository, operationContext) => removeLayer(repository.path, request, operationContext),
        operationMessage('status.layerRemoved', { path: request.targetPath })
      )
      if (succeeded) await refreshCompositionResources('layers', toolSession)
      return succeeded
    },
    [activeSnapshot, refreshCompositionResources, runRepositoryMutation, toolSession]
  )

  const addActiveLink = useCallback(
    async (request: LoreLinkAddRequest): Promise<boolean> => {
      if (!activeSnapshot) return false
      const succeeded = await runRepositoryMutation(
        'addLink',
        (repository, operationContext) => addLink(repository.path, request, operationContext),
        operationMessage('status.linkAdded', { path: request.linkPath })
      )
      if (succeeded) await refreshCompositionResources('links', toolSession)
      return succeeded
    },
    [activeSnapshot, refreshCompositionResources, runRepositoryMutation, toolSession]
  )

  const updateActiveLink = useCallback(
    async (request: LoreLinkUpdateRequest): Promise<boolean> => {
      if (!activeSnapshot) return false
      const succeeded = await runRepositoryMutation(
        'updateLinkPin',
        (repository, operationContext) => updateLink(repository.path, request, operationContext),
        operationMessage('status.linkPinUpdated', { path: request.linkPath })
      )
      if (succeeded) await refreshCompositionResources('links', toolSession)
      return succeeded
    },
    [activeSnapshot, refreshCompositionResources, runRepositoryMutation, toolSession]
  )

  const removeActiveLink = useCallback(
    async (linkPath: string): Promise<boolean> => {
      if (!activeSnapshot) return false
      const succeeded = await runRepositoryMutation(
        'removeLink',
        (repository, operationContext) => removeLink(repository.path, linkPath, operationContext),
        operationMessage('status.linkRemoved', { path: linkPath })
      )
      if (succeeded) await refreshCompositionResources('links', toolSession)
      return succeeded
    },
    [activeSnapshot, refreshCompositionResources, runRepositoryMutation, toolSession]
  )

  /**
   * 读取单条 Link 的完整详情。
   *
   * 详情读取是只读操作，失败时只弹提示并返回 null；不经过仓库写队列，
   * 也不改变 busyAction，避免阻塞其他面板操作。
   */
  const loadActiveLinkInfo = useCallback(
    async (linkPath: string): Promise<LoreLinkDetails | null> => {
      if (!activeSnapshot || applicationMode !== 'tauri' || !isToolSessionCurrent(toolSession)) return null
      try {
        const details = await loadLinkInfo(activeSnapshot.repository.path, linkPath)
        return isToolSessionCurrent(toolSession) ? details : null
      } catch (error) {
        if (isToolSessionCurrent(toolSession)) notify(t('linkInfoUnavailable'), readErrorMessage(error), 'warning')
        return null
      }
    },
    [activeSnapshot, applicationMode, isToolSessionCurrent, notify, toolSession]
  )

  const previewActiveRepositoryView = useCallback(
    async (content: string): Promise<RepositoryViewPreview> => {
      const revision = activeSnapshot?.repository.revision
      if (!activeSnapshot || !revision) throw new Error(t('repositoryViewRequiresCurrentRevision'))
      return previewRepositoryView(activeSnapshot.repository.path, revision, content)
    },
    [activeSnapshot]
  )

  const applyActiveRepositoryView = useCallback(
    async (content: string): Promise<boolean> => {
      const revision = activeSnapshot?.repository.revision
      if (!activeSnapshot || !revision) return false
      const applied = await runRepositoryMutation(
        'applyRepositoryView',
        (repository, operationContext) => applyRepositoryView(repository.path, revision, content, operationContext),
        operationMessage('repositoryViewAppliedAndSynchronized')
      )
      if (applied && isToolSessionCurrent(toolSession)) {
        const requestId = ++resourceRequestCounter.current
        const isCurrent = () => isToolSessionCurrent(toolSession) && requestId === resourceRequestCounter.current
        setLoading(true)
        try {
          const result = await loadRepositoryView(activeSnapshot.repository.path)
          if (isCurrent()) setRepositoryView(result)
        } catch (error) {
          if (isCurrent()) notify(t('repositoryViewApplied'), readErrorMessage(error), 'warning')
        } finally {
          if (isCurrent()) setLoading(false)
        }
      }
      return applied
    },
    [activeSnapshot, isToolSessionCurrent, notify, runRepositoryMutation, toolSession]
  )

  const saveRepositoryConfiguration = useCallback(
    async (identity: string, remoteUrl: string) => {
      if (!activeSnapshot) return
      if (applicationMode === 'browser-demo') {
        const normalizedIdentity = identity.trim() || undefined
        const normalizedRemoteUrl = remoteUrl.trim().replace(/\/+$/, '') || undefined
        upsertSnapshot({
          ...activeSnapshot,
          repository: {
            ...activeSnapshot.repository,
            identity: normalizedIdentity,
            remoteUrl: normalizedRemoteUrl
          }
        })
        notify(t('demoConfigurationUpdated'), t('browserModeUpdatesCurrentSession_1b10'), 'info')
        return
      }
      await runRepositoryMutation(
        'updateRepositoryConfiguration',
        (repository, operationContext) =>
          updateRepositoryConfig(repository.path, identity, remoteUrl, operationContext),
        operationMessage('repositoryIdentityAndRemoteUrlSaved'),
        undefined,
        (snapshot, result) => projectRepositoryConfigurationSnapshot(snapshot, result as RepositoryConfiguration)
      )
    },
    [activeSnapshot, applicationMode, notify, runRepositoryMutation, upsertSnapshot]
  )

  const publishActiveRepository = useCallback(
    async (
      identity: string,
      targetServerUrl: string,
      repositoryName: string,
      description: string,
      authUserId?: string
    ) => {
      if (!activeSnapshot) return
      if (applicationMode !== 'tauri') {
        notify(t('browserDemoMode'), t('startDesktopAppPublishReal_46c2'), 'warning')
        return
      }
      const normalizedServerUrl = targetServerUrl.trim().replace(/\/+$/, '')
      const normalizedName = repositoryName.trim()
      const repositoryUrl = `${normalizedServerUrl}/${normalizedName}`
      if (
        !confirmLocalized(
          t('confirm.publishCreateAndPush', {
            server: repositoryUrl,
            branch: activeSnapshot.repository.branch
          })
        )
      ) {
        return
      }
      await runRepositoryMutation(
        'publishRepository',
        async (repository, operationContext) => {
          const existingAccount = resolvePublishAuthAccount(repository.path, authAccountBindings, [])
          const selectedUserId = authUserId?.trim()
          const selectedIdentity = selectedUserId
            ? publishAuthIdentities.find((candidate) => candidate.userId.trim() === selectedUserId)
            : undefined
          if (selectedUserId && existingAccount?.userId !== selectedUserId && !selectedIdentity) {
            throw new Error(t('accountUnavailable'))
          }

          if (selectedUserId && existingAccount?.userId !== selectedUserId && selectedIdentity) {
            /*
             * 显式选择的账户同时成为仓库绑定，使本次发布后的普通 Push、Sync 和远端
             * 目录读取继续使用同一 Token Store 身份。留空只影响本次发布，不会暗中
             * 删除用户在账户页维护的既有绑定。
             */
            await setRepositoryAuthAccountBinding(
              repository.path,
              selectedUserId,
              selectedIdentity.authUrl,
              operationContext
            )
            const nextBindings = authAccountBindings.filter(
              (binding) => repositoryPathKey(binding.repositoryPath) !== repositoryPathKey(repository.path)
            )
            nextBindings.push({
              repositoryPath: repository.path,
              authUrl: selectedIdentity.authUrl,
              userId: selectedUserId
            })
            onAuthAccountBindingsChange(nextBindings)
          }

          const publish = () =>
            publishRepository(
              repository.path,
              normalizedName,
              description,
              identity,
              defaultIdentity,
              normalizedServerUrl,
              repository.branch,
              selectedUserId,
              operationContext
            )
          try {
            return await publish()
          } catch (error) {
            if (!selectedUserId || !isPublishAuthenticationError(error)) {
              throw error
            }
            /* 发布认证失败同样交给全局决策，不能绕过用户选择直接打开系统浏览器。 */
            onAuthenticationRequired(normalizedServerUrl)
            throw error
          }
        },
        operationMessage('status.repositoryPublishedAndPushed', {
          url: repositoryUrl,
          branch: activeSnapshot.repository.branch
        })
      )
    },
    [
      activeSnapshot,
      applicationMode,
      authAccountBindings,
      defaultIdentity,
      notify,
      onAuthAccountBindingsChange,
      onAuthenticationRequired,
      publishAuthIdentities,
      runRepositoryMutation
    ]
  )

  /** 账户是设备级资源；登录、退出和列表不得要求先打开本地仓库。 */
  const runAuthAction = useCallback(
    async (
      action: (context: OperationContext) => Promise<unknown>,
      serverUrl?: string,
      refreshOnFailure = false
    ): Promise<boolean> => {
      if (applicationMode !== 'tauri') return false
      return withOperationRequest(createOperationContext(null), async (operationContext) => {
        try {
          setAuthActionsPending((count) => count + 1)
          await runAuthenticationMutation(
            () => action(operationContext),
            () => onAuthStateChange(serverUrl, operationContext),
            refreshOnFailure
          )
          return true
        } catch (error) {
          notify(t('accountOperationFailed'), readErrorMessage(error), 'warning')
          return false
        } finally {
          setAuthActionsPending((count) => count - 1)
        }
      })
    },
    [applicationMode, notify, onAuthStateChange]
  )

  const dialogProps = useMemo<RepositoryToolsDialogProps | null>(() => {
    if (!tab || (!activeSnapshot && tab !== 'accounts')) return null
    const ownsResources = toolSession?.repositoryPath === (activeSnapshot?.repository.path ?? '')
    const repository = activeSnapshot?.repository ?? {
      id: 'device-accounts',
      name: t('accounts'),
      branch: t('noWorkspaceOpen'),
      revision: '',
      path: '',
      ahead: 0,
      behind: 0,
      online: false,
      remoteState: 'local',
      color: '#78a4ff',
      conflictCount: 0,
      unresolvedConflictCount: 0
    }
    return {
      tab,
      repository,
      branches: activeSnapshot?.branches ?? [],
      revisions: activeSnapshot?.revisions ?? [],
      defaultIdentity,
      layers: ownsResources ? layers : [],
      links: ownsResources ? links : [],
      locks: fileLocks,
      dependencyQuery: ownsResources ? dependencyQuery : null,
      loading: (ownsResources && loading) || authActionsPending > 0 || isRepositoryToolsBusy(busyAction),
      compositionAvailable: applicationMode === 'tauri',
      lockAvailable: applicationMode === 'tauri',
      dependencyAvailable: applicationMode === 'tauri',
      publishAvailable: applicationMode === 'tauri',
      connectedRemoteDescription: ownsResources ? connectedRemoteDescription : '',
      connectedRemoteName: ownsResources ? connectedRemoteName : '',
      publishAuthIdentities: ownsResources ? publishAuthIdentities : [],
      repositoryView: ownsResources ? repositoryView : null,
      currentRevisionId: repository.revision || undefined,
      viewBlockedReason: activeSnapshot?.conflictSession
        ? t('finishConflictBeforeApplyingView')
        : activeSnapshot?.changes.length
          ? t('cleanWorkspaceBeforeApplyingView')
          : undefined,
      onTabChange: (nextTab) => void open(nextTab),
      onRefresh: () => void open(tab),
      onSaveConfiguration: (identity, remoteUrl) => void saveRepositoryConfiguration(identity, remoteUrl),
      onPublish: (identity, serverUrl, repositoryName, description, authUserId) =>
        void publishActiveRepository(identity, serverUrl, repositoryName, description, authUserId),
      onPushCurrentBranch: () => void pushCurrentRepository(),
      onPreviewView: previewActiveRepositoryView,
      onApplyView: applyActiveRepositoryView,
      onAddLayer: addActiveLayer,
      onRemoveLayer: removeActiveLayer,
      onAddLink: addActiveLink,
      onUpdateLink: updateActiveLink,
      onRemoveLink: removeActiveLink,
      onLoadLinkInfo: loadActiveLinkInfo,
      onAcquireLock: (path) => acquireActiveFileLocks([path]),
      onReleaseLock: (path) => releaseActiveFileLocks([path]),
      onQueryDependencies: queryActiveDependencies,
      onAddDependency: (sourcePath, dependencyPath, tags, force) =>
        runRepositoryMutation(
          'addFileDependency',
          (targetRepository, operationContext) =>
            addFileDependency(targetRepository.path, sourcePath, dependencyPath, tags, force, operationContext),
          operationMessage('status.fileDependencyAdded', {
            source: sourcePath,
            dependency: dependencyPath
          })
        ),
      onRemoveDependency: (sourcePath, dependencyPath, tags) =>
        runRepositoryMutation(
          'removeFileDependency',
          (targetRepository, operationContext) =>
            removeFileDependency(targetRepository.path, sourcePath, dependencyPath, tags, operationContext),
          operationMessage('status.fileDependencyRemoved', {
            source: sourcePath,
            dependency: dependencyPath
          })
        ),
      onDependencySync: (options) =>
        runRepositoryMutation(
          'dependencyDrivenSync',
          (targetRepository, operationContext) => syncRepository(targetRepository.path, options, operationContext),
          operationMessage('status.dependencyDrivenSyncCompleted', {
            count: options.rootFiles.length
          })
        ),
      onLoadBranchCollaboration: (branch) => loadBranchCollaboration(repository.path, branch),
      onLoadBranchDiff: (source, target, path) => loadBranchDiff(repository.path, source, target, path),
      onSetBranchProtected: setActiveBranchProtected,
      onResetBranchLatest: resetActiveBranchLatest,
      onLoadRevisionInfo: (revision) => loadRevisionInfo(repository.path, revision),
      onFindRevisionNumber: (number) => findRevisionByNumber(repository.path, number),
      onFindRevisionMetadata: (key, value) => findRevisionByMetadata(repository.path, key, value),
      onAmendRevision: amendActiveRevision,
      onBisectRevision: bisectActiveRevision,
      onRestoreRevision: restoreActiveRevision,
      onLocateRevision: (revision) => {
        locateRevision(revision)
        close()
      },
      onListAuthIdentities: () => listAuthIdentities(),
      authStateVersion,
      accountRepositories: repositorySnapshots.map((snapshot) => snapshot.repository),
      authAccountBindings,
      onSetAuthAccountBinding: async (targetRepository, identity) => {
        return withOperationRequest(createOperationContext(targetRepository.path), async (operationContext) => {
          try {
            setAuthActionsPending((count) => count + 1)
            await setRepositoryAuthAccountBinding(
              targetRepository.path,
              identity?.userId,
              identity?.authUrl,
              operationContext
            )
            const nextBindings = authAccountBindings.filter(
              (binding) => repositoryPathKey(binding.repositoryPath) !== repositoryPathKey(targetRepository.path)
            )
            if (identity) {
              nextBindings.push({
                repositoryPath: targetRepository.path,
                authUrl: identity.authUrl,
                userId: identity.userId
              })
            }
            onAuthAccountBindingsChange(nextBindings)
            await onAuthStateChange(targetRepository.serverUrl ?? targetRepository.remoteUrl, operationContext)
            return true
          } catch (error) {
            notify(t('unableToUpdateRepositoryAccount'), readErrorMessage(error), 'warning')
            return false
          } finally {
            setAuthActionsPending((count) => count - 1)
          }
        })
      },
      onLoginAuthInteractive: (remoteUrl) =>
        runAuthAction((context) => loginAuthInteractive(remoteUrl, context), remoteUrl),
      onLoginAuthWithToken: (remoteUrl, token, tokenType, authUrl) =>
        runAuthAction((context) => loginAuthWithToken(remoteUrl, token, tokenType, authUrl, context), remoteUrl),
      onLogoutAuthIdentity: (identity) => {
        if (
          !confirmLocalized(
            t('confirm.logoutAuthIdentity', {
              user: identity.userId,
              url: identity.authUrl
            })
          )
        ) {
          return Promise.resolve(false)
        }
        return runAuthAction(
          (context) => logoutAuthIdentity(identity.authUrl, identity.userId, context),
          undefined,
          true
        )
      },
      onClearAuthIdentities: () => {
        if (!confirmLocalized(t('confirm.clearAuthIdentities'))) return Promise.resolve(false)
        return runAuthAction((context) => clearAuthIdentities(context))
      },
      onLoadMetadata: (scope, target, revision) => loadMetadata(repository.path, scope, target, revision),
      onVerifyPath: async (path, heal) => {
        if (!heal) return verifyRepositoryPath(repository.path, path, false)
        let report: LoreDiagnosticReport | null = null
        const succeeded = await runRepositoryMutation(
          'healRepository',
          async (targetRepository, operationContext) => {
            report = await verifyRepositoryPath(targetRepository.path, path, true, operationContext)
          },
          operationMessage('status.repositoryPathHealed', {
            path: path || t('entireRepository')
          })
        )
        if (!succeeded || !report) throw new Error(t('repositoryHealDidNotComplete'))
        return report
      },
      onVerifyFragment: (hash, context, heal) => verifyRepositoryFragment(repository.path, hash, context, heal),
      onDumpRepository: (revision, path, maxDepth) => dumpRepositoryState(repository.path, revision, path, maxDepth),
      onListInstances: () => listRepositoryInstances(repository.path),
      onPruneInstances: () =>
        runRepositoryMutation(
          'pruneRepositoryInstances',
          (targetRepository, operationContext) => pruneRepositoryInstances(targetRepository.path, operationContext),
          operationMessage('status.staleInstancesPruned')
        ),
      onUpdateInstancePath: () =>
        runRepositoryMutation(
          'updateRepositoryInstancePath',
          (targetRepository, operationContext) => updateRepositoryInstancePath(targetRepository.path, operationContext),
          operationMessage('status.instancePathUpdated')
        ),
      onVerify: () => {
        void runRepositoryMutation(
          'verifyRepository',
          (targetRepository, operationContext) => verifyRepository(targetRepository.path, operationContext),
          operationMessage('loreCoreFinishedReadConsistency_86d2')
        )
      },
      onCollectGarbage: () => {
        if (!confirmLocalized(t('confirm.runGc'))) return
        void runRepositoryMutation(
          'collectStorage',
          (targetRepository, operationContext) => collectRepositoryGarbage(targetRepository.path, operationContext),
          operationMessage('loreCoreFinishedCollectingUnreferencedContent')
        )
      },
      onClose: close
    }
  }, [
    activeSnapshot,
    authStateVersion,
    authAccountBindings,
    addActiveLayer,
    addActiveLink,
    amendActiveRevision,
    applicationMode,
    authActionsPending,
    applyActiveRepositoryView,
    acquireActiveFileLocks,
    bisectActiveRevision,
    busyAction,
    close,
    connectedRemoteDescription,
    connectedRemoteName,
    defaultIdentity,
    dependencyQuery,
    fileLocks,
    layers,
    links,
    loading,
    locateRevision,
    loadActiveLinkInfo,
    notify,
    onAuthAccountBindingsChange,
    onAuthStateChange,
    open,
    previewActiveRepositoryView,
    publishActiveRepository,
    publishAuthIdentities,
    pushCurrentRepository,
    queryActiveDependencies,
    releaseActiveFileLocks,
    removeActiveLayer,
    removeActiveLink,
    resetActiveBranchLatest,
    restoreActiveRevision,
    repositoryView,
    repositorySnapshots,
    runAuthAction,
    runRepositoryMutation,
    saveRepositoryConfiguration,
    setActiveBranchProtected,
    tab,
    toolSession,
    updateActiveLink
  ])

  return {
    dialogProps,
    fileLocks,
    fileLockState,
    open,
    close,
    acquireFileLocks: acquireActiveFileLocks,
    releaseFileLocks: releaseActiveFileLocks
  }
}
