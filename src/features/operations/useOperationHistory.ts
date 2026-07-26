import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'

import { subscribeLoreOperationStream } from '../../services/lore'
import type { LoreOperationStreamEvent, LoreOperationStreamRecord, OperationDetail, OperationRecord } from '../../types'
import { normalizeOperationDetail } from './operationDetail'
import { selectRecentOperationHistory } from './operationHistory'
import { mergeLoreOperationStream } from './operationStream'

/** 可以继续占用全局操作计数的 Lore 生命周期阶段。 */
const ACTIVE_STREAM_PHASES = new Set<LoreOperationStreamRecord['phase']>(['queued', 'running', 'streaming'])

/** beginOperation 返回的短生命周期句柄；墙钟时间用于展示，单调时钟用于计算耗时。 */
export interface ActiveOperation {
  id: number
  startedAt: number
}

export interface OperationHistoryState {
  operations: OperationRecord[]
  streams: LoreOperationStreamRecord[]
}

export type OperationHistoryAction =
  | { type: 'begin'; record: OperationRecord }
  | { type: 'finish'; id: number; succeeded: boolean; detail: OperationDetail; durationMs: number }
  | { type: 'stream'; event: LoreOperationStreamEvent }
  | { type: 'clearCompleted' }

export const INITIAL_OPERATION_HISTORY: OperationHistoryState = {
  operations: [],
  streams: []
}

/**
 * 在一次 reducer 转移中同时裁剪普通操作和 Lore 实时流。
 *
 * 两种记录具有同一个全局 200 条上限。如果分别维护 React state，再通过 effect
 * 做二次裁剪，会存在一次短暂渲染暴露 400 条记录，也会制造额外更新。这里将跨来源
 * 不变量收进纯 reducer，既便于测试，也保证任何 action 结束后状态已经有效。
 */
function limitCombinedHistory(state: OperationHistoryState): OperationHistoryState {
  const selected = selectRecentOperationHistory(state.operations, state.streams)
  return {
    operations: selected.operations,
    streams: selected.streams
  }
}

/** 操作历史的纯状态机；不得在这里读取时间、翻译或调用 Lore 服务。 */
export function operationHistoryReducer(
  state: OperationHistoryState,
  action: OperationHistoryAction
): OperationHistoryState {
  switch (action.type) {
    case 'begin':
      return limitCombinedHistory({
        ...state,
        operations: [action.record, ...state.operations]
      })
    case 'finish':
      return {
        ...state,
        operations: state.operations.map((record) =>
          record.id === action.id
            ? {
                ...record,
                detail: action.detail,
                status: action.succeeded ? 'succeeded' : 'failed',
                durationMs: action.durationMs
              }
            : record
        )
      }
    case 'stream':
      return limitCombinedHistory({
        ...state,
        streams: mergeLoreOperationStream(state.streams, action.event)
      })
    case 'clearCompleted':
      return {
        operations: state.operations.filter((record) => record.status === 'running'),
        streams: state.streams.filter((record) => ACTIVE_STREAM_PHASES.has(record.phase))
      }
  }
}

/**
 * 管理操作中心的普通命令记录、Lore 实时流和订阅生命周期。
 *
 * `enabled` 只控制原生事件订阅；浏览器演示模式仍可记录由界面发起的普通操作，
 * 因此不能在禁用订阅时跳过 reducer 或 begin/finish。
 */
export function useOperationHistory(enabled: boolean) {
  const [history, dispatch] = useReducer(operationHistoryReducer, INITIAL_OPERATION_HISTORY)
  const operationCounter = useRef(0)

  const beginOperation = useCallback((labelKey: string, detail: string | OperationDetail): ActiveOperation => {
    operationCounter.current += 1
    const id = operationCounter.current
    dispatch({
      type: 'begin',
      record: {
        id,
        labelKey,
        detail: normalizeOperationDetail(detail),
        status: 'running',
        startedAt: Date.now()
      }
    })
    return { id, startedAt: performance.now() }
  }, [])

  const finishOperation = useCallback(
    (operation: ActiveOperation, succeeded: boolean, detail: string | OperationDetail) => {
      dispatch({
        type: 'finish',
        id: operation.id,
        succeeded,
        detail: normalizeOperationDetail(detail),
        durationMs: Math.round(performance.now() - operation.startedAt)
      })
    },
    []
  )

  const clearCompleted = useCallback(() => {
    dispatch({ type: 'clearCompleted' })
  }, [])

  useEffect(() => {
    if (!enabled) return

    let disposed = false
    let unlisten: (() => void) | undefined
    void subscribeLoreOperationStream((event) => {
      if (!disposed) dispatch({ type: 'stream', event })
    }).then((cleanup) => {
      if (disposed) cleanup()
      else unlisten = cleanup
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [enabled])

  const activeCount = useMemo(
    () =>
      history.operations.filter((record) => record.status === 'running').length +
      history.streams.filter((record) => ACTIVE_STREAM_PHASES.has(record.phase)).length,
    [history.operations, history.streams]
  )

  return {
    operations: history.operations,
    loreOperationStreams: history.streams,
    activeCount,
    beginOperation,
    finishOperation,
    clearCompleted
  }
}
