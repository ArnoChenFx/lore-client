import { describe, expect, it } from 'bun:test'

import type { LoreOperationStreamEvent, OperationContext, OperationRecord } from '../../types'
import {
  INITIAL_OPERATION_HISTORY,
  countActiveOperations,
  operationHistoryReducer as reduce,
  type OperationHistoryState
} from './useOperationHistory'

function context(requestId: string, workspaceKey: string | null = '/workspace/project'): OperationContext {
  return { requestId, workspaceKey }
}
function operation(owner: OperationContext, startedAt = 1): OperationRecord {
  return {
    ...owner,
    labelKey: 'syncRepository',
    detail: { kind: 'text', text: owner.workspaceKey ?? '' },
    status: 'running',
    startedAt
  }
}
function event(owner: OperationContext, operationId = `${owner.requestId}-child`): LoreOperationStreamEvent {
  return {
    ...owner,
    operationId,
    operation: 'repository.sync',
    phase: 'streaming',
    event: { tagName: 'syncProgress', data: { unit: 'files', current: 4, total: 10, elapsedMs: 800 } },
    cancellable: false
  }
}
function admit(state: OperationHistoryState, ...owners: OperationContext[]) {
  return reduce(state, { type: 'requests', activeRequests: [...state.activeRequests, ...owners] })
}
function finish(state: OperationHistoryState, requestId: string) {
  return reduce(state, {
    type: 'finish',
    requestId,
    succeeded: true,
    detail: { kind: 'text', text: 'done' },
    durationMs: 42
  })
}
function release(state: OperationHistoryState, requestId: string) {
  return reduce(state, {
    type: 'requests',
    activeRequests: state.activeRequests.filter((owner) => owner.requestId !== requestId)
  })
}

describe('operation history request ownership', () => {
  it('counts distinct independent requests and deduplicates a workflow with several native children', () => {
    const a = context('A'),
      b = context('B', '/workspace/other')
    let state = admit(INITIAL_OPERATION_HISTORY, a, b)
    state = reduce(state, { type: 'begin', record: operation(a) })
    for (const child of ['a-stage', 'a-push', 'a-refresh']) {
      state = reduce(state, { type: 'stream', event: event(a, child), receivedAt: 1 })
    }
    expect(state.operations).toHaveLength(1)
    expect(state.streams).toHaveLength(3)
    expect(countActiveOperations(state.activeRequests)).toBe(2)
    expect(countActiveOperations([a, a, b])).toBe(2)
    state = release(state, 'A')
    expect(countActiveOperations(state.activeRequests)).toBe(1)
    expect(countActiveOperations(release(state, 'B').activeRequests)).toBe(0)
  })

  it('records one command outcome without inventing successful child outcomes', () => {
    const owner = context('root')
    let state = admit(INITIAL_OPERATION_HISTORY, owner)
    state = reduce(state, { type: 'begin', record: operation(owner) })
    state = reduce(state, { type: 'stream', event: event(owner), receivedAt: 100 })
    state = finish(state, owner.requestId)
    expect(state.operations[0]).toMatchObject({ requestId: 'root', status: 'succeeded', durationMs: 42 })
    expect(state.streams[0]?.phase).toBe('streaming')
    // The root result is idempotent, independently of registry and native terminal delivery.
    expect(
      reduce(state, {
        type: 'finish',
        requestId: 'root',
        succeeded: false,
        detail: { kind: 'text', text: 'duplicate' },
        durationMs: 99
      }).operations
    ).toEqual(state.operations)
    state = release(state, 'root')
    expect(state.streams[0]?.phase).toBe('streaming')
    expect(countActiveOperations(state.activeRequests)).toBe(0)
  })

  it('admits only current-page requests with the same workspace owner', () => {
    const owner = context('root')
    const state = admit(INITIAL_OPERATION_HISTORY, owner)
    for (const incoming of [event(context('old-page')), event(context('root', '/wrong'))]) {
      expect(reduce(state, { type: 'stream', event: incoming, receivedAt: 1 })).toBe(state)
      expect(reduce(state, { type: 'stream', event: { ...incoming, phase: 'succeeded' }, receivedAt: 2 })).toBe(state)
    }
  })

  it('accepts terminal after request finish only for a retained child, never new progress', () => {
    const owner = context('root')
    const progress = event(owner)
    let state = reduce(admit(INITIAL_OPERATION_HISTORY, owner), { type: 'stream', event: progress, receivedAt: 1 })
    state = release(state, 'root')
    expect(reduce(state, { type: 'stream', event: progress, receivedAt: 2 })).toBe(state)
    state = reduce(state, { type: 'stream', event: { ...progress, phase: 'failed' }, receivedAt: 3 })
    expect(state.streams[0]?.phase).toBe('failed')
    expect(
      reduce(state, { type: 'stream', event: { ...progress, operationId: 'unknown', phase: 'failed' }, receivedAt: 4 })
    ).toBe(state)
  })

  it('retains terminal children of a live root across clear, and ignores late events after terminal', () => {
    const owner = context('root')
    const progress = event(owner)
    let state = reduce(admit(INITIAL_OPERATION_HISTORY, owner), { type: 'stream', event: progress, receivedAt: 1 })
    state = reduce(state, { type: 'stream', event: { ...progress, phase: 'succeeded' }, receivedAt: 2 })
    state = reduce(state, { type: 'clearCompleted' })
    expect(state.streams[0]?.phase).toBe('succeeded')
    expect(reduce(state, { type: 'stream', event: progress, receivedAt: 3 }).streams).toEqual(state.streams)
    state = release(state, 'root')
    state = reduce(state, { type: 'clearCompleted' })
    expect(state.streams).toEqual([])
    for (const phase of ['streaming', 'failed', 'succeeded'] as const) {
      expect(reduce(state, { type: 'stream', event: { ...progress, phase }, receivedAt: 4 })).toBe(state)
    }
  })

  it('keeps all active requests and their stages beyond the completed history budget', () => {
    let state = INITIAL_OPERATION_HISTORY
    for (let index = 0; index < 250; index += 1) {
      const owner = context(String(index))
      state = admit(state, owner)
      state = reduce(state, { type: 'begin', record: operation(owner, index) })
      state = reduce(state, { type: 'stream', event: { ...event(owner), phase: 'succeeded' }, receivedAt: index })
    }
    expect(state.operations).toHaveLength(250)
    expect(state.streams).toHaveLength(250)
    expect(countActiveOperations(state.activeRequests)).toBe(250)
    expect(reduce(state, { type: 'clearCompleted' }).streams).toHaveLength(250)
  })

  it('trims a finished request even when its child final progress never arrives, without later resurrection', () => {
    const owner = context('long-running')
    const progress = event(owner)
    let state = admit(INITIAL_OPERATION_HISTORY, owner)
    state = reduce(state, { type: 'begin', record: operation(owner, 0) })
    state = reduce(state, { type: 'stream', event: progress, receivedAt: 0 })
    for (let index = 1; index <= 210; index += 1) {
      const newer = context(`new-${index}`)
      state = reduce(state, { type: 'begin', record: { ...operation(newer, index), status: 'succeeded' } })
    }
    expect(state.operations).toHaveLength(201)
    expect(state.streams).toHaveLength(1)
    state = release(state, owner.requestId)
    expect(state.operations).toHaveLength(200)
    expect(state.streams).toHaveLength(0)
    for (const phase of ['streaming', 'succeeded'] as const) {
      expect(reduce(state, { type: 'stream', event: { ...progress, phase }, receivedAt: 999 })).toBe(state)
    }
  })

  it('uses arrival timestamps from dispatch for progress and elapsed time', () => {
    const owner = context('root')
    let state = admit(INITIAL_OPERATION_HISTORY, owner)
    state = reduce(state, { type: 'stream', event: event(owner), receivedAt: 5_000 })
    state = reduce(state, { type: 'stream', event: event(owner), receivedAt: 7_500 })
    expect(state.streams).toEqual([expect.objectContaining({ startedAt: 5_000, progressAt: 7_500, eventCount: 2 })])
  })
})
