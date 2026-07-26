import { describe, expect, it } from 'vitest'

import type { LoreOperationStreamEvent, OperationRecord } from '../../types'
import { INITIAL_OPERATION_HISTORY, operationHistoryReducer, type OperationHistoryState } from './useOperationHistory'

function runningOperation(id: number, startedAt: number): OperationRecord {
  return {
    id,
    labelKey: 'syncRepository',
    detail: { kind: 'text', text: `repository-${id}` },
    status: 'running',
    startedAt
  }
}

function stream(operationId: string, startedAt: number): OperationHistoryState['streams'][number] {
  return {
    operationId,
    operation: 'repository.sync',
    phase: 'running',
    startedAt,
    eventCount: 0,
    cancellable: false
  }
}

describe('operation history controller', () => {
  it('records begin and finish as one deterministic lifecycle', () => {
    const begun = operationHistoryReducer(INITIAL_OPERATION_HISTORY, {
      type: 'begin',
      record: runningOperation(1, 100)
    })
    const finished = operationHistoryReducer(begun, {
      type: 'finish',
      id: 1,
      succeeded: true,
      detail: { kind: 'i18n', key: 'status.completed' },
      durationMs: 42
    })

    expect(finished.operations).toEqual([
      expect.objectContaining({
        id: 1,
        status: 'succeeded',
        detail: { kind: 'i18n', key: 'status.completed' },
        durationMs: 42
      })
    ])
  })

  it('keeps a combined limit across commands and Lore streams', () => {
    let state = INITIAL_OPERATION_HISTORY
    for (let index = 0; index < 150; index += 1) {
      state = operationHistoryReducer(state, {
        type: 'begin',
        record: runningOperation(index + 1, index + 1)
      })
    }
    for (let index = 0; index < 100; index += 1) {
      const event: LoreOperationStreamEvent = {
        operationId: `stream-${index + 1}`,
        operation: 'repository.sync',
        phase: 'running',
        cancellable: false
      }
      /*
       * mergeLoreOperationStream 使用接收时刻作为首次开始时间；这里先注入确定性记录，
       * 再验证 reducer 的跨来源裁剪，不让测试依赖墙钟速度。
       */
      state = {
        ...state,
        streams: [stream(event.operationId, 151 + index), ...state.streams]
      }
      state = operationHistoryReducer(state, {
        type: 'stream',
        event: { ...event, phase: 'streaming' }
      })
    }

    expect(state.operations.length + state.streams.length).toBe(200)
    expect(state.operations[0]?.id).toBe(150)
    expect(state.streams).toHaveLength(100)
  })

  it('clears completed records while preserving active work', () => {
    const state: OperationHistoryState = {
      operations: [
        runningOperation(1, 1),
        { ...runningOperation(2, 2), status: 'failed' },
        { ...runningOperation(3, 3), status: 'succeeded' }
      ],
      streams: [
        stream('running', 1),
        { ...stream('queued', 2), phase: 'queued' },
        { ...stream('done', 3), phase: 'succeeded' }
      ]
    }

    const cleared = operationHistoryReducer(state, { type: 'clearCompleted' })

    expect(cleared.operations.map((record) => record.id)).toEqual([1])
    expect(cleared.streams.map((record) => record.operationId)).toEqual(['running', 'queued'])
  })
})
