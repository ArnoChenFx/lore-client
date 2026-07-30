import { isTauri } from '@tauri-apps/api/core'

const IPC_FAILURE_SETTLE_DELAY_MS = 100
const RELOAD_GUARD_HEADER = 'X-Lore-Ipc-Reload-Guard'
const RELOAD_GUARD_MARKER = Symbol.for('lore.tauriIpcReloadGuard')

export interface TauriIpcReloadGuard {
  fetch: typeof fetch
  markUnloading: () => void
}

/** 识别 Tauri 在桌面 WebView 中使用的专用 IPC fetch，避免影响任何业务网络请求。 */
function isTauriIpcRequest(input: RequestInfo | URL, baseUrl: string): boolean {
  let rawUrl: string
  if (typeof input === 'string') rawUrl = input
  else if (input instanceof URL) rawUrl = input.href
  else rawUrl = input.url

  try {
    const url = new URL(rawUrl, baseUrl)
    return (
      url.protocol === 'ipc:' ||
      ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname === 'ipc.localhost')
    )
  } catch {
    return false
  }
}

/**
 * 为 Tauri IPC 创建页面卸载保护层。
 *
 * Tauri 2.11.5 的 Windows custom-protocol 实现会在页面 reload 中止 fetch 时，把
 * `TypeError: Failed to fetch` 当成协议不可用并立即通过 postMessage 重发同一命令。
 * 原命令及重发命令都可能在新页面建立后完成，从而把旧 callback ID 注入新页面。
 *
 * 页面已经进入卸载阶段后，旧 Promise 不再有合法消费者，因此让它保持 pending 是
 * 最小且安全的处理：浏览器销毁旧 JavaScript realm 时会自然回收它；活动页面中的真实
 * IPC 协议故障仍会 reject，由 Tauri 按原设计执行 fallback。
 */
export function createTauriIpcReloadGuard(nativeFetch: typeof fetch, baseUrl: string): TauriIpcReloadGuard {
  let unloading = false

  return {
    markUnloading: () => {
      unloading = true
    },
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      if (!isTauriIpcRequest(input, baseUrl)) return nativeFetch(input, init)

      // 诊断头只进入 Tauri 的本机 IPC 协议，供真实桌面回归确认保护层没有被绕过。
      const headers = new Headers(init?.headers)
      headers.set(RELOAD_GUARD_HEADER, '1')
      const response = nativeFetch(input, { ...init, headers })

      return response.catch(
        (error) =>
          new Promise<Response>((_resolve, reject) => {
            /*
             * WebView2 偶尔会先 reject 导航中止的 fetch，随后才派发 beforeunload。
             * 等待短暂的 100 ms 导航窗口再判断，既覆盖这个次序窗口，也只给活动页面中
             * 极少发生的真实协议故障增加有界延迟；旧 realm 若已销毁，计时器也会被回收。
             */
            globalThis.setTimeout(() => {
              if (!unloading) reject(error)
              // 已卸载时刻意不 settle，阻止 Tauri 把导航中止误判为协议故障。
            }, IPC_FAILURE_SETTLE_DELAY_MS)
          })
      )
    }) as typeof fetch
  }
}

let installed = false

/** 在第一个业务 IPC 发出前安装一次，并在最早的页面卸载事件上关闭 fallback。 */
export function installTauriIpcReloadGuard(): void {
  if (installed || typeof window === 'undefined' || !isTauri()) return
  installed = true

  const guard = createTauriIpcReloadGuard(window.fetch.bind(window), window.location.href)
  window.fetch = guard.fetch
  Object.defineProperty(window, RELOAD_GUARD_MARKER, { value: true })
  window.addEventListener('beforeunload', guard.markUnloading, { once: true })
  window.addEventListener('pagehide', guard.markUnloading, { once: true })
}
