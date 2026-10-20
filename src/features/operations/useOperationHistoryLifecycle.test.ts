import { afterAll, afterEach, describe, expect, it, vi } from 'bun:test'

import {
  acquireOperationRequest,
  createOperationContext,
  getActiveOperationRequests
} from '../../services/operationRequests'
import type { LoreOperationStreamEvent } from '../../types'

type EffectSlot = {
  kind: 'effect'
  dependencies: readonly unknown[]
  create: () => void | (() => void)
  cleanup?: () => void
}
interface HookState {
  cursor: number
  slots: unknown[]
  effects: (() => void)[]
  mounted: boolean
  writesAfterUnmount: number
}
let currentHooks: HookState
const reactActual = { ...(await import('react')) }
const loreActual = { ...(await import('../../services/lore')) }
let streamListener: ((event: LoreOperationStreamEvent) => void) | undefined
const nativeUnlisten = vi.fn()
vi.mock('../../services/lore', () => ({
  ...loreActual,
  subscribeLoreOperationStream: async (listener: (event: LoreOperationStreamEvent) => void) => {
    streamListener = listener
    return nativeUnlisten
  }
}))
vi.mock('react', () => ({
  ...reactActual,
  useRef: <T>(value: T) => {
    const index = currentHooks.cursor++
    if (!(index in currentHooks.slots)) currentHooks.slots[index] = { current: value }
    return currentHooks.slots[index]
  },
  useCallback: <T>(callback: T) => {
    const index = currentHooks.cursor++
    if (!(index in currentHooks.slots)) currentHooks.slots[index] = callback
    return currentHooks.slots[index]
  },
  useReducer: <S, A, I>(reducer: (state: S, action: A) => S, initial: I, initialize: (initial: I) => S) => {
    const hooks = currentHooks
    const index = hooks.cursor++
    if (!(index in hooks.slots)) hooks.slots[index] = initialize(initial)
    return [
      hooks.slots[index],
      (action: A) => {
        if (!hooks.mounted) hooks.writesAfterUnmount += 1
        hooks.slots[index] = reducer(hooks.slots[index] as S, action)
      }
    ]
  },
  useEffect: (create: () => void | (() => void), dependencies: readonly unknown[]) => {
    const hooks = currentHooks
    const index = hooks.cursor++
    const previous = hooks.slots[index] as EffectSlot | undefined
    if (
      previous &&
      dependencies.length === previous.dependencies.length &&
      dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))
    )
      return
    hooks.effects.push(() => {
      previous?.cleanup?.()
      hooks.slots[index] = { kind: 'effect', create, dependencies, cleanup: create() }
    })
  }
}))
const { useOperationHistory } = await import('./useOperationHistory')
const cleanups: (() => void)[] = []
function harness(enabled = false) {
  const hooks: HookState = { cursor: 0, slots: [], effects: [], mounted: true, writesAfterUnmount: 0 }
  const render = () => {
    currentHooks = hooks
    hooks.cursor = 0
    return useOperationHistory(enabled)
  }
  const effectSlots = () =>
    hooks.slots.filter(
      (slot): slot is EffectSlot => !!slot && typeof slot === 'object' && 'kind' in slot && slot.kind === 'effect'
    )
  const flushEffects = () => {
    for (const effect of hooks.effects.splice(0)) effect()
  }
  const replayEffects = () => {
    for (const slot of effectSlots()) slot.cleanup?.()
    for (const slot of effectSlots()) slot.cleanup = slot.create() || undefined
  }
  const unmount = () => {
    if (!hooks.mounted) return
    for (const slot of effectSlots()) slot.cleanup?.()
    hooks.mounted = false
  }
  cleanups.push(unmount)
  return { render, flushEffects, replayEffects, unmount, hooks }
}
function lease(workspaceKey: string | null) {
  const context = createOperationContext(workspaceKey)
  const release = acquireOperationRequest(context)
  cleanups.push(release)
  return { context, release }
}
async function tick() {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  await tick()
  expect(getActiveOperationRequests()).toEqual([])
})
afterAll(() => {
  vi.mock('react', () => reactActual)
  vi.mock('../../services/lore', () => loreActual)
})

describe('operation history hook lifecycle', () => {
  it('includes requests started before rendering and between rendering and effect subscription', () => {
    const first = lease('/repo/A')
    const page = harness()
    expect(page.render().activeRequests).toEqual([first.context])
    const second = lease('/repo/B')
    page.flushEffects()
    expect(page.render().activeCount).toBe(2)
    first.release()
    expect(page.render().activeRequests).toEqual([second.context])
    second.release()
    expect(page.render().activeCount).toBe(0)
  })

  it('keeps a root begun before effects alive through StrictMode replay and finishes only once', async () => {
    const page = harness()
    const actions = page.render()
    const root = actions.beginOperation('sync', '/repo/A', '/repo/A')
    page.flushEffects()
    expect(page.render().activeCount).toBe(1)
    page.replayEffects()
    await tick()
    expect(getActiveOperationRequests()).toEqual([root.context])
    actions.finishOperation(root, true, 'done')
    actions.finishOperation(root, false, 'late failure')
    expect(page.render().activeCount).toBe(0)
    expect(page.render().operations).toEqual([
      expect.objectContaining({
        requestId: root.context.requestId,
        status: 'succeeded',
        detail: { kind: 'text', text: 'done' }
      })
    ])
  })

  it('releases owned roots on unmount while a pending child IPC keeps its independent lease', async () => {
    const page = harness()
    const actions = page.render()
    page.flushEffects()
    const root = actions.beginOperation('sync', '/repo/A', '/repo/A')
    const releaseChild = acquireOperationRequest(root.context)
    cleanups.push(releaseChild)
    page.unmount()
    await tick()
    expect(getActiveOperationRequests()).toEqual([root.context])
    releaseChild()
    expect(getActiveOperationRequests()).toEqual([])
    actions.finishOperation(root, true, 'late completion')
    const staleRoot = actions.beginOperation('sync', '/repo/B', '/repo/B')
    actions.finishOperation(staleRoot, false, 'stale callback')
    expect(getActiveOperationRequests()).toEqual([])
    expect(page.hooks.writesAfterUnmount).toBe(0)
  })

  it('releases an abandoned root without requiring its finish callback after unmount', async () => {
    const page = harness()
    const actions = page.render()
    page.flushEffects()
    actions.beginOperation('sync', '/repo/A', '/repo/A')
    expect(getActiveOperationRequests()).toHaveLength(1)
    page.unmount()
    await tick()
    expect(getActiveOperationRequests()).toEqual([])
    expect(page.hooks.writesAfterUnmount).toBe(0)
  })

  it('ignores old-page progress after remount and stops delivering events to unmounted state', async () => {
    const page = harness(true)
    const actions = page.render()
    page.flushEffects()
    await tick()
    const root = actions.beginOperation('sync', '/repo/A', '/repo/A')
    const event: LoreOperationStreamEvent = {
      ...root.context,
      operationId: 'child',
      operation: 'file.stage',
      phase: 'streaming',
      cancellable: false
    }
    streamListener!(event)
    expect(page.render().loreOperationStreams).toHaveLength(1)
    page.unmount()
    await tick()
    streamListener!(event)
    expect(page.hooks.writesAfterUnmount).toBe(0)
    const nextPage = harness(true)
    nextPage.render()
    nextPage.flushEffects()
    await tick()
    streamListener!(event)
    streamListener!({ ...event, phase: 'succeeded' })
    expect(nextPage.render().loreOperationStreams).toEqual([])
    expect(nextPage.render().activeCount).toBe(0)
  })
})
