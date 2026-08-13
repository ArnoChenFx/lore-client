import { describe, expect, it, vi } from 'vitest'

import { createTauriIpcReloadGuard } from './tauriIpcReloadGuard'

describe('Tauri IPC reload guard', () => {
  it('leaves protocol failures visible while the page remains active', async () => {
    const failure = new TypeError('Failed to fetch')
    const nativeFetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.reject(failure))
    // mock 函数不能直接断言为 fetch 签名（TS 不允许不相关类型直接 as）；
    // 双重断言是测试标准做法，SAFETY: 已由 nativeFetchMock 的参数签名约束。
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    const nativeFetch = nativeFetchMock as unknown as typeof fetch
    const guard = createTauriIpcReloadGuard(nativeFetch, 'http://tauri.localhost/')

    await expect(guard.fetch('http://ipc.localhost/lore_repository_status')).rejects.toBe(failure)
    const requestInit = nativeFetchMock.mock.calls[0]?.[1]
    expect(new Headers(requestInit?.headers).get('X-Lore-Ipc-Reload-Guard')).toBe('1')
  })

  it('keeps an aborted IPC fetch pending after page unload instead of triggering Tauri fallback', async () => {
    // mock 函数不能直接断言为 fetch 签名；双重断言是测试标准做法。
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    const nativeFetch = vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch
    const guard = createTauriIpcReloadGuard(nativeFetch, 'http://tauri.localhost/')
    const guardedFetch = guard.fetch('http://ipc.localhost/lore_repository_status')
    let settled = false
    void guardedFetch.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    // 模拟 WebView2 先报告 fetch 失败、随后才派发卸载事件的次序。
    await Promise.resolve()
    guard.markUnloading()
    await new Promise((resolve) => setTimeout(resolve, 120))

    expect(settled).toBe(false)
  })

  it('does not swallow unrelated fetch failures during unload', async () => {
    const failure = new TypeError('Failed to fetch')
    // mock 函数不能直接断言为 fetch 签名；双重断言是测试标准做法。
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    const nativeFetch = vi.fn(() => Promise.reject(failure)) as unknown as typeof fetch
    const guard = createTauriIpcReloadGuard(nativeFetch, 'http://tauri.localhost/')
    guard.markUnloading()

    await expect(guard.fetch('https://example.com/data')).rejects.toBe(failure)
  })
})
