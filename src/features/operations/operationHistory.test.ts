import { describe, expect, it } from 'bun:test'

import type { LoreOperationStreamRecord, OperationRecord } from '../../types'
import { MAX_OPERATION_HISTORY, selectRecentOperationHistory } from './operationHistory'

function operation(id: number, startedAt = id): OperationRecord {
  return {
    id,
    labelKey: 'sync',
    detail: { kind: 'i18n', key: 'status.completed', values: {} },
    status: 'succeeded',
    startedAt
  }
}

function stream(id: number, startedAt = id): LoreOperationStreamRecord {
  return {
    requestId: `stream-${id}`,
    workspaceKey: '/workspace/project',
    operationId: `stream-${id}`,
    operation: 'repository.sync',
    phase: 'succeeded',
    startedAt,
    eventCount: 0,
    cancellable: false
  }
}

describe('operation history limit', () => {
  it('keeps only the latest 200 entries from one source', () => {
    const records = Array.from({ length: MAX_OPERATION_HISTORY + 5 }, (_, index) =>
      operation(MAX_OPERATION_HISTORY + 5 - index)
    )

    const limited = selectRecentOperationHistory(records, []).operations

    expect(limited).toHaveLength(MAX_OPERATION_HISTORY)
    expect(limited[0]?.id).toBe(MAX_OPERATION_HISTORY + 5)
    expect(limited.at(-1)?.id).toBe(6)
  })

  it('keeps only the latest 200 entries across operations and live streams', () => {
    const operations = Array.from({ length: 150 }, (_, index) => operation(index + 1, index + 1))
    const streams = Array.from({ length: 100 }, (_, index) => stream(index + 151, index + 151))

    const selected = selectRecentOperationHistory(operations, streams)

    expect(selected.operations).toHaveLength(100)
    expect(selected.operations[0]?.id).toBe(51)
    expect(selected.streams).toHaveLength(100)
    expect(selected.operations.length + selected.streams.length).toBe(MAX_OPERATION_HISTORY)
  })

  it('preserves active records outside the completed-history budget in both sources', () => {
    const active = { ...operation(0), status: 'running' as const }
    const queued = { ...stream(0), phase: 'queued' as const }
    const completed = Array.from({ length: MAX_OPERATION_HISTORY + 5 }, (_, index) => operation(index + 1))
    const selected = selectRecentOperationHistory([active, ...completed], [queued])

    expect(selected.operations).toContain(active)
    expect(selected.streams).toEqual([queued])
    expect(selected.operations.filter((record) => record.status !== 'running')).toHaveLength(MAX_OPERATION_HISTORY)
    expect(selected.operations.map((record) => record.id)).not.toContain(5)
  })
})
