import { useEffect } from 'react'

import type { ApplicationMode, NavigationView } from '../../types'

interface UseLocalChangesAutoRefreshOptions {
  applicationMode: ApplicationMode
  activeView: NavigationView
  repositoryPath: string
  refresh: () => Promise<unknown>
}

/** 只有桌面端已打开仓库且正在查看本地更改时，才允许监听外部磁盘变化。 */
export function shouldAutoRefreshLocalChanges(
  applicationMode: ApplicationMode,
  activeView: NavigationView,
  repositoryPath: string
): boolean {
  return applicationMode === 'tauri' && activeView === 'changes' && Boolean(repositoryPath)
}

/**
 * 从外部编辑器回到应用时重新扫描本地更改。
 *
 * `visibilitychange` 覆盖窗口被遮挡或最小化后的恢复，`focus` 覆盖普通应用切换；
 * 离开本地更改视图后立即移除监听，避免其他工作区产生无关磁盘读取。
 */
export function useLocalChangesAutoRefresh({
  applicationMode,
  activeView,
  repositoryPath,
  refresh
}: UseLocalChangesAutoRefreshOptions) {
  useEffect(() => {
    if (!shouldAutoRefreshLocalChanges(applicationMode, activeView, repositoryPath)) return

    const refreshSnapshot = () => {
      void refresh()
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshSnapshot()
    }

    refreshSnapshot()
    window.addEventListener('focus', refreshSnapshot)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.removeEventListener('focus', refreshSnapshot)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [activeView, applicationMode, refresh, repositoryPath])
}
