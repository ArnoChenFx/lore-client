import { useEffect, useRef, useState } from 'react'

import { t } from '../../i18n'
import { loadRepositorySnapshot } from '../../services/lore'
import { initializeClientPreferences } from '../../services/preferences'
import { readErrorMessage } from '../../shared/lib'
import type { ApplicationMode, ClientPreferences, RepositorySnapshot } from '../../types'
import type { AppNotify } from './controllerTypes'
import { repositorySessionKey } from './useRepositorySession'

interface UseRepositorySessionLifecycleOptions {
  applicationMode: ApplicationMode
  snapshots: RepositorySnapshot[]
  activeRepositoryId: string
  unavailableRepositoryPaths: string[]
  replaceRepositorySession: (snapshots: RepositorySnapshot[], unavailablePaths: string[]) => void
  activateSnapshot: (snapshot: RepositorySnapshot) => void
  updatePreferences: (patch: Partial<ClientPreferences>) => void
  setBusyAction: (action: string | null) => void
  notify: AppNotify
}

type StoredRepositorySessionPreferences = Pick<ClientPreferences, 'repositoryPaths' | 'activeRepositoryPath'>

interface RestoreRepositorySessionOptions {
  loadPreferences: () => Promise<StoredRepositorySessionPreferences>
  loadSnapshot: (repositoryPath: string) => Promise<RepositorySnapshot>
  isCurrent: () => boolean
}

export interface RestoredRepositorySession {
  storedPreferences: StoredRepositorySessionPreferences
  restoredSnapshots: RepositorySnapshot[]
  failedPaths: string[]
}

/** 按保存路径恢复首选仓库；路径失效时稳定回退到第一个成功快照。 */
export function restoredActiveSnapshot(
  snapshots: RepositorySnapshot[],
  preferredPath: string | null
): RepositorySnapshot | undefined {
  return snapshots.find((snapshot) => snapshot.repository.path === preferredPath) ?? snapshots[0]
}

/**
 * 生成会话持久化路径。
 *
 * 读取失败的旧路径必须保留，避免一次离线启动永久丢失项目标签；已恢复路径按大小写
 * 不敏感规则去重，兼容 Windows 文件系统。
 */
export function repositoryPathsForPersistence(
  snapshots: RepositorySnapshot[],
  unavailableRepositoryPaths: string[]
): string[] {
  return [
    ...snapshots.map((snapshot) => snapshot.repository.path),
    ...unavailableRepositoryPaths.filter(
      (path) => !snapshots.some((snapshot) => snapshot.repository.path.toLocaleLowerCase() === path.toLocaleLowerCase())
    )
  ]
}

/**
 * 串行读取一次可被代际淘汰的仓库会话。
 *
 * 已进入 Rust 的 IPC 不能由普通 Promise cleanup 取消，因此本函数不伪造“取消成功”；
 * 它在每个 await 后检查当前代际，一旦调用方已经卸载或开始了新代际，就停止下一条 IPC
 * 并返回 null，保证旧结果不会再进入 React 会话。
 */
export async function restoreRepositorySession({
  loadPreferences,
  loadSnapshot,
  isCurrent
}: RestoreRepositorySessionOptions): Promise<RestoredRepositorySession | null> {
  const storedPreferences = await loadPreferences()
  if (!isCurrent()) return null

  const restoredSnapshots: RepositorySnapshot[] = []
  const failedPaths: string[] = []
  for (const repositoryPath of storedPreferences.repositoryPaths) {
    try {
      const restoredSnapshot = await loadSnapshot(repositoryPath)
      if (!isCurrent()) return null
      restoredSnapshots.push(restoredSnapshot)
    } catch {
      if (!isCurrent()) return null
      failedPaths.push(repositoryPath)
    }
  }

  return isCurrent() ? { storedPreferences, restoredSnapshots, failedPaths } : null
}

/**
 * 恢复并持久化多仓库会话。
 *
 * “恢复是否开始/完成”只服务于这一条启动生命周期，因此由 Hook 私有持有；App 无需
 * 知道中间状态，也不会在恢复未完成时把空会话覆盖回偏好文件。
 */
export function useRepositorySessionLifecycle({
  applicationMode,
  snapshots,
  activeRepositoryId,
  unavailableRepositoryPaths,
  replaceRepositorySession,
  activateSnapshot,
  updatePreferences,
  setBusyAction,
  notify
}: UseRepositorySessionLifecycleOptions) {
  const [sessionReady, setSessionReady] = useState(applicationMode === 'browser-demo')
  const restoreGeneration = useRef(0)
  const lifecycleOptions = useRef({
    replaceRepositorySession,
    activateSnapshot,
    setBusyAction,
    notify
  })
  // 在 effect 内维护“最新回调”引用：恢复流程的异步回调始终读到当前值，而回调
  // 本身不进入恢复 effect 依赖，避免恢复流程因回调引用变化重复启动。
  useEffect(() => {
    lifecycleOptions.current = {
      replaceRepositorySession,
      activateSnapshot,
      setBusyAction,
      notify
    }
  })

  useEffect(() => {
    if (applicationMode !== 'tauri') return

    const generation = ++restoreGeneration.current
    let disposed = false
    const isCurrent = () => !disposed && restoreGeneration.current === generation

    /*
     * 延迟到微任务再开始，令 StrictMode 第一次 setup 的同步 cleanup 能先使本代际失效；
     * 第二次 setup 才会真正发出偏好与仓库 IPC，避免为了开发期检查重复恢复整批仓库。
     */
    queueMicrotask(() => {
      if (!isCurrent()) return
      lifecycleOptions.current.setBusyAction('restoringRepositories')
      void restoreRepositorySession({
        loadPreferences: initializeClientPreferences,
        loadSnapshot: (repositoryPath) => loadRepositorySnapshot(repositoryPath, false),
        isCurrent
      })
        .then((result) => {
          if (!result || !isCurrent()) return
          const { restoredSnapshots, failedPaths, storedPreferences } = result
          lifecycleOptions.current.replaceRepositorySession(restoredSnapshots, failedPaths)
          const preferredSnapshot = restoredActiveSnapshot(restoredSnapshots, storedPreferences.activeRepositoryPath)
          if (preferredSnapshot) lifecycleOptions.current.activateSnapshot(preferredSnapshot)
          if (failedPaths.length > 0) {
            lifecycleOptions.current.notify(
              t('someRepositoriesCouldNotBeRestored'),
              t('status.savedDirectoriesUnavailable', { count: failedPaths.length }),
              'warning'
            )
          }
        })
        .catch((error) => {
          if (isCurrent()) {
            lifecycleOptions.current.notify(t('failedToLoadClientPreferences'), readErrorMessage(error), 'warning')
          }
        })
        .finally(() => {
          if (!isCurrent()) return
          setSessionReady(true)
          lifecycleOptions.current.setBusyAction(null)
        })
    })

    return () => {
      disposed = true
    }
  }, [applicationMode])

  useEffect(() => {
    if (applicationMode !== 'tauri' || !sessionReady) return
    const activePath =
      snapshots.find((snapshot) => repositorySessionKey(snapshot) === activeRepositoryId)?.repository.path ?? null
    updatePreferences({
      repositoryPaths: repositoryPathsForPersistence(snapshots, unavailableRepositoryPaths),
      activeRepositoryPath: activePath
    })
  }, [activeRepositoryId, applicationMode, sessionReady, snapshots, unavailableRepositoryPaths, updatePreferences])
}
