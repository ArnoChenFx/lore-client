import { afterEach, describe, expect, it } from 'bun:test'

import {
  acquireOperationRequest,
  createOperationContext,
  getActiveOperationRequests,
  subscribeOperationRequests,
  withOperationRequest,
  type OperationRequestEvent
} from './operationRequests'

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const release of cleanup.splice(0)) release()
  expect(getActiveOperationRequests()).toEqual([])
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function acquire(context: ReturnType<typeof createOperationContext>) {
  const release = acquireOperationRequest(context)
  cleanup.push(release)
  return release
}

function observe() {
  const events: OperationRequestEvent[] = []
  cleanup.push(subscribeOperationRequests((event) => events.push(event)))
  return events
}

describe('explicit operation request lifetimes', () => {
  it('creates distinct immutable owners without normalizing native path facts', () => {
    const a = createOperationContext('/tmp/Repo ')
    const b = createOperationContext('/tmp/repo')
    expect(a.requestId).not.toBe(b.requestId)
    expect(a.workspaceKey).toBe('/tmp/Repo ')
    expect(b.workspaceKey).toBe('/tmp/repo')
    expect(Object.isFrozen(a)).toBe(true)
    expect(createOperationContext(null).workspaceKey).toBeNull()
  })

  it('keeps a workflow alive when one child IPC ends and publishes only its outer lifetime', () => {
    const events = observe()
    const context = createOperationContext('/tmp/A')
    const finishRoot = acquire(context)
    const finishChild = acquire(context)
    finishChild()
    finishChild()
    expect(getActiveOperationRequests()).toEqual([context])
    expect(events.map((event) => event.type)).toEqual(['started'])
    finishRoot()
    expect(getActiveOperationRequests()).toEqual([])
    expect(events.map((event) => event.type)).toEqual(['started', 'finished'])
  })

  it('keeps already-started IPC alive if its outer owner is released first', () => {
    const context = createOperationContext('/tmp/A')
    const finishRoot = acquire(context)
    const finishChild = acquire(context)
    finishRoot()
    expect(getActiveOperationRequests()).toEqual([context])
    finishChild()
    expect(getActiveOperationRequests()).toEqual([])
  })

  it('tracks overlapping requests independently through out-of-order completion', () => {
    const a = createOperationContext('/tmp/A')
    const b = createOperationContext('/tmp/B')
    const finishA = acquire(a)
    const finishB = acquire(b)
    finishA()
    expect(getActiveOperationRequests()).toEqual([b])
    finishB()
    expect(getActiveOperationRequests()).toEqual([])
  })

  it('rejects a shared ID being reused for a different workspace without changing its owner', () => {
    const context = createOperationContext('/tmp/A')
    const finish = acquire(context)
    expect(() => acquireOperationRequest({ ...context, workspaceKey: '/tmp/B' })).toThrow('workspace owner')
    expect(getActiveOperationRequests()).toEqual([context])
    finish()
  })

  it('copies externally supplied context so later mutation cannot corrupt the live owner', () => {
    const input = { requestId: 'explicit-request', workspaceKey: '/tmp/A' }
    const finish = acquire(input)
    input.workspaceKey = '/tmp/B'
    const snapshot = getActiveOperationRequests()
    expect(snapshot).toEqual([{ requestId: 'explicit-request', workspaceKey: '/tmp/A' }])
    expect(Object.isFrozen(snapshot[0])).toBe(true)
    snapshot.splice(0)
    expect(getActiveOperationRequests()).toHaveLength(1)
    finish()
  })

  it('includes an already-running request in a new observer snapshot and stops notifications after unsubscribe', () => {
    const context = createOperationContext('/tmp/A')
    const finish = acquire(context)
    const events: OperationRequestEvent[] = []
    const unsubscribe = subscribeOperationRequests((event) => events.push(event))
    expect(getActiveOperationRequests()).toEqual([context])
    unsubscribe()
    finish()
    expect(events).toEqual([])
  })

  it('preserves one lifetime across asynchronous gaps between child calls', async () => {
    const context = createOperationContext('/tmp/A')
    const events = observe()
    const gap = deferred<void>()
    const pending = withOperationRequest(context, async (received) => {
      expect(received).toBe(context)
      acquireOperationRequest(received)()
      await gap.promise
      acquireOperationRequest(received)()
      return 'completed'
    })
    expect(events.map((event) => event.type)).toEqual(['started'])
    expect(getActiveOperationRequests()).toEqual([context])
    gap.resolve()
    expect(await pending).toBe('completed')
    expect(events.map((event) => event.type)).toEqual(['started', 'finished'])
  })

  it('releases failed scopes while preserving the actual error object', async () => {
    const context = createOperationContext('/tmp/A')
    const failure = new Error('failed operation')
    await expect(
      withOperationRequest(context, async () => {
        throw failure
      })
    ).rejects.toBe(failure)
    expect(getActiveOperationRequests()).toEqual([])
  })
})
