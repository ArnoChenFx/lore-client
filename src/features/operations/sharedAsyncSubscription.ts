/** 原生异步订阅返回的清理函数；Tauri 类型声明为 void，运行时实际可能返回 Promise。 */
type AsyncCleanup = () => void | Promise<void>

/**
 * 页面级共享异步订阅。
 *
 * React StrictMode 会同步执行 setup → cleanup → setup，但 Tauri `listen()` 需要一次异步
 * IPC 才能取得 event id。若每个 Effect 各自注册，第一次 cleanup 时通常还拿不到
 * unlisten，Rust 就会短暂保留两份 listener。这里把原生订阅提升为页面模块级资源：
 *
 * - 多个 React 租约只共享一份原生 listener；
 * - 最后一个租约释放后延迟一个微任务，跨过 StrictMode 的同步重放窗口；
 * - 真正 unlisten 完成前不重新 listen，避免后端清理与新注册再次交错；
 * - React listener 在 release 时立即从集合移除，不接收清理窗口中的陈旧事件。
 */
export function createSharedAsyncSubscription<T>(
  subscribeNative: (listener: (value: T) => void) => Promise<AsyncCleanup>,
  onError: (error: unknown) => void = () => undefined
) {
  const listeners = new Set<(value: T) => void>()
  let nativeSubscription: Promise<void> | null = null
  let nativeCleanup: AsyncCleanup | null = null
  let nativeClosing: Promise<void> | null = null
  let releaseGeneration = 0

  const dispatch = (value: T) => {
    // listener 可能在回调中释放自己的租约，复制快照可避免遍历期间修改集合造成漏投递。
    const listenerSnapshot = Array.from(listeners)
    for (const listener of listenerSnapshot) listener(value)
  }

  const ensureNativeSubscription = () => {
    if (listeners.size === 0 || nativeSubscription || nativeCleanup || nativeClosing) return

    const pending = subscribeNative(dispatch)
      .then((cleanup) => {
        if (nativeSubscription !== pending) {
          void Promise.resolve(cleanup()).catch(onError)
          return
        }
        nativeSubscription = null
        nativeCleanup = cleanup
        // 最后租约若已在 listen 解析前释放，先前的微任务宽限已经结束，可立即清理。
        if (listeners.size === 0) closeNativeSubscription()
      })
      .catch((error) => {
        if (nativeSubscription === pending) nativeSubscription = null
        onError(error)
      })
    nativeSubscription = pending
  }

  const closeNativeSubscription = () => {
    if (!nativeCleanup || nativeClosing) return
    const cleanup = nativeCleanup
    nativeCleanup = null
    let cleanupResult: void | Promise<void>
    try {
      // Tauri unlisten 会先同步删除 JS callback，再异步通知 Rust；必须在这里立即启动。
      cleanupResult = cleanup()
    } catch (error) {
      onError(error)
      cleanupResult = undefined
    }
    nativeClosing = Promise.resolve(cleanupResult)
      .catch(onError)
      .then(() => undefined)
      .finally(() => {
        nativeClosing = null
        ensureNativeSubscription()
      })
  }

  function scheduleNativeRelease() {
    const scheduledGeneration = ++releaseGeneration
    queueMicrotask(() => {
      if (scheduledGeneration !== releaseGeneration || listeners.size > 0) return
      // listen 尚未完成时无需主动取消 Promise；解析分支会再次调用本函数并完成清理。
      closeNativeSubscription()
    })
  }

  return {
    subscribe(listener: (value: T) => void): () => void {
      let released = false
      releaseGeneration += 1
      listeners.add(listener)
      ensureNativeSubscription()

      return () => {
        if (released) return
        released = true
        listeners.delete(listener)
        if (listeners.size === 0) scheduleNativeRelease()
      }
    }
  }
}
