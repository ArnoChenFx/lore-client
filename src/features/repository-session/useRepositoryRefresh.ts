import { useCallback, useEffect, useRef, useState } from 'react'

import { connectRepositoryNotifications, loadRepositorySnapshot } from '../../services/lore'
import { LatestTaskQueue } from '../../shared/lib'
import type { LoreRepositoryNotification, RepositoryRemoteState, RepositorySnapshot } from '../../types'

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

/** 通知流结束不是普通数据通知，必须释放旧订阅并建立新连接。 */
export function isRepositoryNotificationDisconnected(notification: LoreRepositoryNotification): boolean {
  return notification.event.tagName === 'notificationUnsubscribed'
}

/** 纯本地仓库和明确未授权都不应由后台网络轮询反复探测。 */
export function shouldAutomaticallyRecoverRepository(remoteState: RepositoryRemoteState): boolean {
  return remoteState === 'offline'
}

const RECOVERY_BASE_DELAY_MS = 1_000
const RECOVERY_MAX_DELAY_MS = 30_000
/** 首次实时通知只在仓库连续保持活动后建立；快照读取不受该窗口影响。 */
export const REPOSITORY_NOTIFICATION_STABLE_DELAY_MS = 3_000

/**
 * 将活动 Repository 的通知连接收敛为“一个建立中连接 + 一个最新目标”。
 *
 * Tauri invoke 不能在进入 Rust 后取消；若每次标签切换都直接执行 Subscribe，旧 effect
 * 即使已经 disposed，也会先注册 WebView listener 并占用 blocking worker。该协调器让
 * 中间 Repository 意图在执行真实连接前被淘汰，同时保留首个活动连接的正常清理机会。
 */
export class RepositoryNotificationConnectionQueue {
  private readonly queue = new LatestTaskQueue()

  activate() {
    this.queue.activate()
  }

  connect<T>(task: () => Promise<T>): Promise<T> {
    return this.queue.run(task)
  }

  cancelPending() {
    this.queue.cancelPending()
  }

  dispose() {
    this.queue.dispose()
  }
}

/**
 * 生成带轻微抖动的有上限指数退避，防止多个仓库或多个客户端同时轰击刚恢复的服务。
 * `random` 作为参数暴露只为让测试可重复；生产调用始终使用 `Math.random`。
 */
export function getRepositoryRecoveryDelay(attempt: number, random: () => number = Math.random): number {
  const normalizedAttempt = Math.max(0, Math.floor(attempt))
  const exponentialDelay = Math.min(RECOVERY_BASE_DELAY_MS * 2 ** normalizedAttempt, RECOVERY_MAX_DELAY_MS)
  const jitter = 0.8 + Math.min(1, Math.max(0, random())) * 0.4
  return Math.min(RECOVERY_MAX_DELAY_MS, Math.round(exponentialDelay * jitter))
}

interface UseRepositoryRefreshOptions {
  enabled: boolean
  /** 用户主动离线时只暂停后台远端恢复；显式本地扫描仍须可用。 */
  networkEnabled?: boolean
  repositoryPath: string
  remoteState: RepositoryRemoteState
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
  networkEnabled = true,
  repositoryPath,
  remoteState,
  upsertSnapshot,
  onRefreshError
}: UseRepositoryRefreshOptions) {
  const mutationInFlight = useRef(false)
  const snapshotRefreshPaths = useRef(new Set<string>())
  const notificationRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const notificationConnectionQueue = useRef(new RepositoryNotificationConnectionQueue())
  const [refreshingRepositoryPaths, setRefreshingRepositoryPaths] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    const queue = notificationConnectionQueue.current
    queue.activate()
    return () => queue.dispose()
  }, [])

  const tryBeginRepositoryMutation = useCallback(() => {
    if (mutationInFlight.current) return false
    mutationInFlight.current = true
    return true
  }, [])

  const finishRepositoryMutation = useCallback(() => {
    mutationInFlight.current = false
  }, [])

  const loadAndUpsertSnapshot = useCallback(
    async (path: string, scan: boolean, reportError: boolean): Promise<RepositorySnapshot | null> => {
      if (!enabled || !path || mutationInFlight.current || snapshotRefreshPaths.current.has(path)) {
        return null
      }

      snapshotRefreshPaths.current.add(path)
      setRefreshingRepositoryPaths((current) => {
        const next = new Set(current)
        next.add(path)
        return next
      })
      try {
        const snapshot = await loadRepositorySnapshot(path, scan)
        upsertSnapshot(snapshot)
        return snapshot
      } catch (error) {
        if (reportError) onRefreshError(error)
        return null
      } finally {
        snapshotRefreshPaths.current.delete(path)
        setRefreshingRepositoryPaths((current) => {
          const next = new Set(current)
          next.delete(path)
          return next
        })
      }
    },
    [enabled, onRefreshError, upsertSnapshot]
  )

  const refreshActiveRepositorySnapshot = useCallback(async () => {
    await loadAndUpsertSnapshot(repositoryPath, true, true)
  }, [loadAndUpsertSnapshot, repositoryPath])

  useEffect(() => {
    if (!enabled || !networkEnabled || !repositoryPath || !shouldAutomaticallyRecoverRepository(remoteState)) return

    let disposed = false
    let attempt = 0
    let recoveryTimer: ReturnType<typeof setTimeout> | null = null

    const scheduleRecovery = (immediate = false) => {
      if (disposed) return
      if (recoveryTimer) clearTimeout(recoveryTimer)
      const delay = immediate ? 0 : getRepositoryRecoveryDelay(attempt++)
      recoveryTimer = setTimeout(() => {
        recoveryTimer = null
        void loadAndUpsertSnapshot(repositoryPath, false, false).then((snapshot) => {
          if (disposed) return
          /*
           * 成功恢复、远端被移除或明确未授权都会由新快照终止轮询；失败和仍离线才
           * 继续退避。React 收到新快照后也会按 remoteState 重建或清除此 effect。
           */
          if (!snapshot || shouldAutomaticallyRecoverRepository(snapshot.repository.remoteState)) {
            scheduleRecovery()
          }
        })
      }, delay)
    }

    const recoverImmediately = () => scheduleRecovery(true)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') recoverImmediately()
    }

    scheduleRecovery()
    window.addEventListener('online', recoverImmediately)
    window.addEventListener('focus', recoverImmediately)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      disposed = true
      if (recoveryTimer) clearTimeout(recoveryTimer)
      window.removeEventListener('online', recoverImmediately)
      window.removeEventListener('focus', recoverImmediately)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [enabled, loadAndUpsertSnapshot, networkEnabled, remoteState, repositoryPath])

  useEffect(() => {
    if (!enabled || !networkEnabled || !repositoryPath || remoteState !== 'online') return

    const connectionQueue = notificationConnectionQueue.current
    let disposed = false
    let disconnect: (() => Promise<void>) | undefined
    let connecting = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let reconnectAttempt = 0
    let checkedSnapshotAfterLoss = false

    const refreshAfterNotification = () => {
      if (notificationRefreshTimer.current) clearTimeout(notificationRefreshTimer.current)
      notificationRefreshTimer.current = setTimeout(() => {
        void loadAndUpsertSnapshot(repositoryPath, false, false)
      }, 300)
    }

    const scheduleReconnect = (immediate = false) => {
      if (disposed || disconnect) return
      if (reconnectTimer) clearTimeout(reconnectTimer)
      const delay = immediate ? 0 : getRepositoryRecoveryDelay(reconnectAttempt++)
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        void connect()
      }, delay)
    }

    const handleDisconnected = async () => {
      const cleanup = disconnect
      disconnect = undefined
      if (cleanup) {
        try {
          await cleanup()
        } catch {
          // 上游已经断开时 Unsubscribe 也可能失败；本地监听仍由 cleanup 的 finally 释放。
        }
      }
      if (!checkedSnapshotAfterLoss) {
        checkedSnapshotAfterLoss = true
        void loadAndUpsertSnapshot(repositoryPath, false, false)
      }
      scheduleReconnect()
    }

    const connect = async () => {
      if (disposed || disconnect || connecting) return
      connecting = true
      try {
        const cleanup = await connectionQueue.connect(() =>
          connectRepositoryNotifications(repositoryPath, (notification) => {
            if (isRepositoryNotificationDisconnected(notification)) {
              void handleDisconnected()
              return
            }
            if (isRepositoryRefreshNotification(notification)) refreshAfterNotification()
          })
        )
        if (disposed) {
          void cleanup()
        } else {
          disconnect = cleanup
          reconnectAttempt = 0
          checkedSnapshotAfterLoss = false
        }
      } catch {
        // 被新 Repository 意图替代的旧 effect 已经 disposed，不得再读取旧快照或重试。
        if (disposed) return
        /* 通知是附加能力；失败后退避重试，但不打断本地工作流或连续弹 Toast。 */
        if (!checkedSnapshotAfterLoss) {
          checkedSnapshotAfterLoss = true
          void loadAndUpsertSnapshot(repositoryPath, false, false)
        }
        scheduleReconnect()
      } finally {
        connecting = false
      }
    }

    const reconnectImmediately = () => {
      if (!disconnect) scheduleReconnect(true)
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') reconnectImmediately()
    }

    /*
     * 通知是附加能力，不需要在 Repository 标签刚被选中的同一帧建立。先经过 3 秒
     * 稳定窗口：快速切换只会反复取消尚未执行的计时器，既不注册 WebView
     * listener，也不进入 Lore Subscribe；用户停留后才连接最终 Repository。
     */
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connect()
    }, REPOSITORY_NOTIFICATION_STABLE_DELAY_MS)
    window.addEventListener('online', reconnectImmediately)
    window.addEventListener('focus', reconnectImmediately)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      disposed = true
      // 队列中尚未进入 Tauri 的旧 Repository 连接必须随 effect 一并释放。
      connectionQueue.cancelPending()
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (notificationRefreshTimer.current) {
        clearTimeout(notificationRefreshTimer.current)
        notificationRefreshTimer.current = null
      }
      window.removeEventListener('online', reconnectImmediately)
      window.removeEventListener('focus', reconnectImmediately)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      if (disconnect) void disconnect()
    }
  }, [enabled, loadAndUpsertSnapshot, networkEnabled, remoteState, repositoryPath])

  return {
    refreshingRepositoryPaths,
    refreshActiveRepositorySnapshot,
    tryBeginRepositoryMutation,
    finishRepositoryMutation
  }
}
