import { describe, expect, it } from 'bun:test'

import type { LoreOperationStreamEvent, OperationRecord } from '../../types'
import {
  INITIAL_OPERATION_HISTORY,
  countActiveOperations,
  operationHistoryReducer,
  type OperationHistoryState
} from './useOperationHistory'

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
      // 到达时间由 action 给出，流记录比所有命令记录都新，裁剪结果不依赖墙钟速度。
      state = operationHistoryReducer(state, { type: 'stream', event, receivedAt: 151 + index })
      state = operationHistoryReducer(state, {
        type: 'stream',
        event: { ...event, phase: 'streaming' },
        receivedAt: 151 + index
      })
    }

    expect(state.operations.length + state.streams.length).toBe(200)
    expect(state.operations[0]?.id).toBe(150)
    expect(state.streams).toHaveLength(100)
  })

  it('stamps stream records with the arrival time carried by the action, not the clock', () => {
    const progressEvent: LoreOperationStreamEvent = {
      operationId: 'stream-1',
      operation: 'file.stage',
      phase: 'streaming',
      event: {
        tagName: 'fileStageProgress',
        data: { unit: 'files', current: 12, totalFinal: false, elapsedMs: 800 }
      },
      cancellable: false
    }
    let state = operationHistoryReducer(INITIAL_OPERATION_HISTORY, {
      type: 'stream',
      event: progressEvent,
      receivedAt: 5_000
    })
    state = operationHistoryReducer(state, { type: 'stream', event: progressEvent, receivedAt: 7_500 })

    expect(state.streams).toEqual([expect.objectContaining({ startedAt: 5_000, progressAt: 7_500, eventCount: 2 })])
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

describe('active operation count', () => {
  it('counts one push once even though it has both a command record and a live stream', () => {
    expect(countActiveOperations([runningOperation(1, 1)], [stream('push', 1)])).toBe(1)
  })

  it('still counts work that only one side knows about', () => {
    expect(countActiveOperations([], [stream('background', 1)])).toBe(1)
    expect(countActiveOperations([runningOperation(1, 1), runningOperation(2, 2)], [])).toBe(2)
    expect(countActiveOperations([], [])).toBe(0)
  })

  it('ignores operations that already finished', () => {
    const finishedCommand: OperationRecord = { ...runningOperation(1, 1), status: 'succeeded' }
    const finishedStream = { ...stream('done', 1), phase: 'failed' as const }
    expect(countActiveOperations([finishedCommand], [finishedStream])).toBe(0)
    expect(countActiveOperations([finishedCommand], [stream('push', 2), finishedStream])).toBe(1)
  })
})
