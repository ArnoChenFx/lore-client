import { useEffect, useRef, useState } from 'react'

import { t } from '../../i18n'
import { loadRepositorySnapshot } from '../../services/lore'
import { initializeClientPreferences } from '../../services/preferences'
import { readErrorMessage } from '../../shared/lib'
import type { ApplicationMode, ClientPreferences, RepositorySnapshot } from '../../types'
import type { AppNotify } from './controllerTypes'

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
  const restoreStarted = useRef(false)

  useEffect(() => {
    if (applicationMode !== 'tauri' || restoreStarted.current) return
    restoreStarted.current = true

    setBusyAction('restoringRepositories')
    void initializeClientPreferences()
      .then(async (storedPreferences) => {
        const restoredSnapshots: RepositorySnapshot[] = []
        const failedPaths: string[] = []

        /*
         * Lore Store 首次打开可能包含同步 I/O。按保存顺序串行恢复既保留项目标签顺序，
         * 又避免应用启动瞬间并发扫描多个大型工作区。
         */
        for (const repositoryPath of storedPreferences.repositoryPaths) {
          try {
            restoredSnapshots.push(await loadRepositorySnapshot(repositoryPath, false))
          } catch {
            failedPaths.push(repositoryPath)
          }
        }

        replaceRepositorySession(restoredSnapshots, failedPaths)
        const preferredSnapshot = restoredActiveSnapshot(restoredSnapshots, storedPreferences.activeRepositoryPath)
        if (preferredSnapshot) activateSnapshot(preferredSnapshot)
        if (failedPaths.length > 0) {
          notify(
            t('someRepositoriesCouldNotBeRestored'),
            t('status.savedDirectoriesUnavailable', { count: failedPaths.length }),
            'warning'
          )
        }
      })
      .catch((error) => {
        notify(t('failedToLoadClientPreferences'), readErrorMessage(error), 'warning')
      })
      .finally(() => {
        setSessionReady(true)
        setBusyAction(null)
      })
  }, [activateSnapshot, applicationMode, notify, replaceRepositorySession, setBusyAction])

  useEffect(() => {
    if (applicationMode !== 'tauri' || !sessionReady) return
    const activePath =
      snapshots.find((snapshot) => snapshot.repository.id === activeRepositoryId)?.repository.path ?? null
    updatePreferences({
      repositoryPaths: repositoryPathsForPersistence(snapshots, unavailableRepositoryPaths),
      activeRepositoryPath: activePath
    })
  }, [activeRepositoryId, applicationMode, sessionReady, snapshots, unavailableRepositoryPaths, updatePreferences])
}
