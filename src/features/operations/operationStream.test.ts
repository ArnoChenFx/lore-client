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

  it('keeps accumulated progress on an old active stream while other streams complete', () => {
    const event = {
      operationId: 'long-clone',
      operation: 'repository.clone',
      phase: 'streaming' as const,
      event: { tagName: 'cloneProgress', data: { current: 4, total: 10 } },
      cancellable: false
    }
    let records = mergeLoreOperationStream([], event, 1)
    for (let index = 0; index < 220; index += 1) {
      records = mergeLoreOperationStream(
        records,
        {
          operationId: `completed-${index}`,
          operation: 'repository.sync',
          phase: 'succeeded',
          cancellable: false
        },
        index + 2
      )
    }
    records = mergeLoreOperationStream(records, event, 500)
    expect(records).toHaveLength(201)
    expect(records[0]).toMatchObject({ operationId: 'long-clone', startedAt: 1, eventCount: 2, current: 4 })
  })

  it('trims a long stream on completion without evicting a newer completed record', () => {
    let records = mergeLoreOperationStream(
      [],
      {
        operationId: 'long-task',
        operation: 'repository.clone',
        phase: 'running',
        cancellable: false
      },
      1
    )
    for (let index = 0; index < 200; index += 1) {
      records = mergeLoreOperationStream(
        records,
        {
          operationId: `done-${index}`,
          operation: 'repository.sync',
          phase: 'succeeded',
          cancellable: false
        },
        index + 2
      )
    }
    records = mergeLoreOperationStream(
      records,
      {
        operationId: 'long-task',
        operation: 'repository.clone',
        phase: 'succeeded',
        cancellable: false
      },
      500
    )
    expect(records).toHaveLength(200)
    expect(records.some((record) => record.operationId === 'long-task')).toBe(false)
    expect(records.some((record) => record.operationId === 'done-0')).toBe(true)
  })
})
