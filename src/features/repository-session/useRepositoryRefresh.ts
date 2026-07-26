import { useCallback, useEffect, useRef, useState } from 'react'

import { connectRepositoryNotifications, loadRepositorySnapshot } from '../../services/lore'
import type { LoreRepositoryNotification, RepositorySnapshot } from '../../types'

const REFRESH_NOTIFICATION_TAGS = new Set([
  'notificationBranchCreated',
  'notificationBranchDeleted',
  'notificationBranchPushed',
  'notificationResourceLocked',
  'notificationResourceUnlocked'
])

/** 仅资源结构变化需要重新读取完整仓库快照；其他通知由对应面板按需处理。 */
export function isRepositoryRefreshNotification(notification: LoreRepositoryNotification): boolean {
  return REFRESH_NOTIFICATION_TAGS.has(notification.event.tagName)
}

interface UseRepositoryRefreshOptions {
  enabled: boolean
  repositoryPath: string
  upsertSnapshot: (snapshot: RepositorySnapshot) => void
  onRefreshError: (error: unknown) => void
}

/**
 * 管理活动仓库的通知刷新、主动扫描去重和写操作门闩。
 *
 * 写操作与扫描共享同一个 ref：开始写入后焦点/可见性刷新必须跳过；扫描进行中也按
 * 仓库路径去重。门闩只表达互斥，不携带 UI 文案，busy 状态仍由具体用例维护。
 */
export function useRepositoryRefresh({
  enabled,
  repositoryPath,
  upsertSnapshot,
  onRefreshError
}: UseRepositoryRefreshOptions) {
  const mutationInFlight = useRef(false)
  const snapshotRefreshPaths = useRef(new Set<string>())
  const notificationRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [refreshingRepositoryPaths, setRefreshingRepositoryPaths] = useState<Set<string>>(() => new Set())

  const tryBeginRepositoryMutation = useCallback(() => {
    if (mutationInFlight.current) return false
    mutationInFlight.current = true
    return true
  }, [])

  const finishRepositoryMutation = useCallback(() => {
    mutationInFlight.current = false
  }, [])

  const refreshActiveRepositorySnapshot = useCallback(async () => {
    if (!enabled || !repositoryPath || mutationInFlight.current || snapshotRefreshPaths.current.has(repositoryPath)) {
      return
    }

    snapshotRefreshPaths.current.add(repositoryPath)
    setRefreshingRepositoryPaths((current) => {
      const next = new Set(current)
      next.add(repositoryPath)
      return next
    })
    try {
      upsertSnapshot(await loadRepositorySnapshot(repositoryPath, true))
    } catch (error) {
      onRefreshError(error)
    } finally {
      snapshotRefreshPaths.current.delete(repositoryPath)
      setRefreshingRepositoryPaths((current) => {
        const next = new Set(current)
        next.delete(repositoryPath)
        return next
      })
    }
  }, [enabled, onRefreshError, repositoryPath, upsertSnapshot])

  useEffect(() => {
    if (!enabled || !repositoryPath) return

    let disposed = false
    let disconnect: (() => Promise<void>) | undefined
    void connectRepositoryNotifications(repositoryPath, (notification) => {
      if (!isRepositoryRefreshNotification(notification)) return
      if (notificationRefreshTimer.current) clearTimeout(notificationRefreshTimer.current)
      notificationRefreshTimer.current = setTimeout(() => {
        void loadRepositorySnapshot(repositoryPath, false)
          .then((snapshot) => {
            if (!disposed) upsertSnapshot(snapshot)
          })
          .catch(() => {
            // 通知刷新是附加能力；显式刷新仍会展示完整错误。
          })
      }, 300)
    })
      .then((cleanup) => {
        if (disposed) void cleanup()
        else disconnect = cleanup
      })
      .catch(() => {
        // 离线、未认证或旧服务器不支持通知时保留正常仓库工作流。
      })

    return () => {
      disposed = true
      if (notificationRefreshTimer.current) {
        clearTimeout(notificationRefreshTimer.current)
        notificationRefreshTimer.current = null
      }
      if (disconnect) void disconnect()
    }
  }, [enabled, repositoryPath, upsertSnapshot])

  return {
    refreshingRepositoryPaths,
    refreshActiveRepositorySnapshot,
    tryBeginRepositoryMutation,
    finishRepositoryMutation
  }
}
