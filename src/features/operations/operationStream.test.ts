import { describe, expect, it } from 'bun:test'

import { mergeLoreOperationStream } from './operationStream'

describe('Lore operation stream reducer', () => {
  it('never revives a terminal stream when progress arrives late', () => {
    const progress = {
      requestId: 'completed-request',
      workspaceKey: null,
      operationId: 'completed-request-stage',
      operation: 'revision.sync',
      phase: 'streaming' as const,
      event: { tagName: 'revisionSyncProgress', data: { current: 4, total: 10 } },
      cancellable: false
    }
    for (const phase of ['succeeded', 'failed', 'cancelled'] as const) {
      const running = mergeLoreOperationStream([], progress, 1)
      const completed = mergeLoreOperationStream(running, { ...progress, phase, event: undefined }, 2)

      expect(mergeLoreOperationStream(completed, progress, 3)).toEqual(completed)
    }
  })

  it('merges lifecycle events and keeps only lightweight progress metrics', () => {
    let records = mergeLoreOperationStream(
      [],
      {
        requestId: 'operation-1',
        workspaceKey: null,
        operationId: 'operation-1',
        operation: 'repository.clone',
        phase: 'queued',
        cancellable: false
      },
      1_000
    )
    records = mergeLoreOperationStream(
      records,
      {
        requestId: 'operation-1',
        workspaceKey: null,
        operationId: 'operation-1',
        operation: 'repository.clone',
        phase: 'streaming',
        event: {
          tagName: 'cloneProgress',
          data: { current: 4, total: 10, bytes: 8_192, patch: 'must not be retained' }
        },
        cancellable: false
      },
      1_100
    )
    records = mergeLoreOperationStream(
      records,
      {
        requestId: 'operation-1',
        workspaceKey: null,
        operationId: 'operation-1',
        operation: 'repository.clone',
        phase: 'succeeded',
        durationMs: 250,
        status: 0,
        cancellable: false
      },
      1_250
    )

    expect(records).toEqual([
      expect.objectContaining({
        operationId: 'operation-1',
        phase: 'succeeded',
        startedAt: 1_000,
        eventCount: 1,
        lastEventTag: 'cloneProgress',
        current: 4,
        total: 10,
        bytes: 8_192,
        durationMs: 250,
        cancellable: false
      })
    ])
    expect(records[0]).not.toHaveProperty('event')
  })

  it('rejects identity changes and does not regress queued/running after progress', () => {
    const incoming = {
      requestId: 'root',
      workspaceKey: '/repo',
      operationId: 'child',
      operation: 'file.stage',
      phase: 'streaming' as const,
      cancellable: false
    }
    const records = mergeLoreOperationStream([], incoming, 1)
    for (const changed of [
      { ...incoming, requestId: 'other' },
      { ...incoming, workspaceKey: '/other' },
      { ...incoming, operation: 'repository.sync' },
      { ...incoming, phase: 'queued' as const }
    ])
      expect(mergeLoreOperationStream(records, changed, 2)).toBe(records)
  })
})
