import { describe, expect, it } from 'bun:test'

import { mergeLoreOperationStream } from './operationStream'

describe('Lore operation stream reducer', () => {
  it('merges lifecycle events and keeps only lightweight progress metrics', () => {
    let records = mergeLoreOperationStream(
      [],
      {
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
})
