import { describe, expect, it, vi } from 'vitest'

import { createSharedAsyncSubscription } from './sharedAsyncSubscription'

describe('shared async subscription', () => {
  it('reuses one native listener across a StrictMode cleanup and setup replay', async () => {
    let emit: ((value: string) => void) | undefined
    let resolveNative: ((cleanup: () => void) => void) | undefined
    const nativeCleanup = vi.fn()
    const subscribeNative = vi.fn(
      (listener: (value: string) => void) =>
        new Promise<() => void>((resolve) => {
          emit = listener
          resolveNative = resolve
        })
    )
    const subscription = createSharedAsyncSubscription(subscribeNative)
    const firstListener = vi.fn()
    const secondListener = vi.fn()

    const releaseFirst = subscription.subscribe(firstListener)
    releaseFirst()
    const releaseSecond = subscription.subscribe(secondListener)

    expect(subscribeNative).toHaveBeenCalledTimes(1)
    resolveNative?.(nativeCleanup)
    await Promise.resolve()
    emit?.('ready')

    expect(firstListener).not.toHaveBeenCalled()
    expect(secondListener).toHaveBeenCalledWith('ready')
    expect(nativeCleanup).not.toHaveBeenCalled()

    releaseSecond()
    await Promise.resolve()
    await Promise.resolve()
    expect(nativeCleanup).toHaveBeenCalledTimes(1)
  })

  it('cleans a pending native listener when the final lease is released', async () => {
    let resolveNative: ((cleanup: () => void) => void) | undefined
    const nativeCleanup = vi.fn()
    const subscription = createSharedAsyncSubscription(
      () =>
        new Promise<() => void>((resolve) => {
          resolveNative = resolve
        })
    )

    const release = subscription.subscribe(vi.fn())
    release()
    await Promise.resolve()
    resolveNative?.(nativeCleanup)
    await Promise.resolve()

    expect(nativeCleanup).toHaveBeenCalledTimes(1)
  })
})
