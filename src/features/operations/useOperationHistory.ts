import { useCallback, useEffect, useReducer, useRef } from 'react'

import { subscribeLoreOperationStream } from '../../services/lore'
import {
  acquireOperationRequest,
  createOperationContext,
  getActiveOperationRequests,
  subscribeOperationRequests
} from '../../services/operationRequests'
import type {
  LoreOperationStreamEvent,
  LoreOperationStreamRecord,
  OperationContext,
  OperationDetail,
  OperationRecord
} from '../../types'
import { normalizeOperationDetail } from './operationDetail'
import { isActiveStreamPhase, isOperationRequestActive, selectRecentOperationHistory } from './operationHistory'
import { mergeLoreOperationStream } from './operationStream'
import { createSharedAsyncSubscription } from './sharedAsyncSubscription'

const loreOperationStreamSubscription = createSharedAsyncSubscription(subscribeLoreOperationStream, (error) =>
  console.error('Failed to subscribe to the Lore operation stream', error)
)

/** Explicit workflow owner; child IPC calls acquire independent leases for this same context. */
export interface ActiveOperation {
  context: OperationContext
  startedAt: number
  release: () => void
}

export interface OperationHistoryState {
  operations: OperationRecord[]
  streams: LoreOperationStreamRecord[]
  activeRequests: OperationContext[]
}

export type OperationHistoryAction =
  | { type: 'begin'; record: OperationRecord }
  | { type: 'finish'; requestId: string; succeeded: boolean; detail: OperationDetail; durationMs: number }
  | { type: 'requests'; activeRequests: OperationContext[] }
  | { type: 'stream'; event: LoreOperationStreamEvent; receivedAt: number }
  | { type: 'clearCompleted' }

export const INITIAL_OPERATION_HISTORY: OperationHistoryState = {
  operations: [],
  streams: [],
  activeRequests: []
}

function limitCombinedHistory(state: OperationHistoryState): OperationHistoryState {
  return { ...state, ...selectRecentOperationHistory(state.operations, state.streams, state.activeRequests) }
}

/** A request can own a user command, several native children, or only background IPC. */
export function countActiveOperations(activeRequests: readonly OperationContext[]): number {
  return new Set(activeRequests.map((context) => context.requestId)).size
}

export function operationHistoryReducer(
  state: OperationHistoryState,
  action: OperationHistoryAction
): OperationHistoryState {
  switch (action.type) {
    case 'begin':
      return limitCombinedHistory({ ...state, operations: [action.record, ...state.operations] })
    case 'finish':
      return limitCombinedHistory({
        ...state,
        operations: state.operations.map((record) =>
          record.requestId === action.requestId && record.status === 'running'
            ? {
                ...record,
                detail: action.detail,
                status: action.succeeded ? 'succeeded' : 'failed',
                durationMs: action.durationMs
              }
            : record
        )
      })
    case 'requests':
      return limitCombinedHistory({ ...state, activeRequests: action.activeRequests })
    case 'stream': {
      const existing = state.streams.find((record) => record.operationId === action.event.operationId)
      // Late terminal delivery may complete a retained child. It cannot recreate history or
      // admit an unknown request from a previous page, and late progress cannot revive a request.
      if (
        !isOperationRequestActive(action.event, state.activeRequests) &&
        (isActiveStreamPhase(action.event.phase) || !existing)
      )
        return state
      return limitCombinedHistory({
        ...state,
        streams: mergeLoreOperationStream(state.streams, action.event, action.receivedAt)
      })
    }
    case 'clearCompleted':
      return {
        ...state,
        operations: state.operations.filter((record) => isOperationRequestActive(record, state.activeRequests)),
        streams: state.streams.filter((record) => isOperationRequestActive(record, state.activeRequests))
      }
  }
}

/** Registry leases are the single source of liveness, independent of the selected workspace. */
export function useOperationHistory(enabled: boolean) {
  const [history, dispatch] = useReducer(operationHistoryReducer, undefined, () => ({
    ...INITIAL_OPERATION_HISTORY,
    activeRequests: getActiveOperationRequests()
  }))
  const ownedOperations = useRef(new Map<string, ActiveOperation>())
  const mounted = useRef(true)
  const generation = useRef({ value: 0 })

  const beginOperation = useCallback(
    (labelKey: string, detail: string | OperationDetail, workspaceKey: string | null = null): ActiveOperation => {
      const context = createOperationContext(workspaceKey)
      const releaseRequest = acquireOperationRequest(context)
      const operation: ActiveOperation = {
        context,
        startedAt: performance.now(),
        release: () => {
          ownedOperations.current.delete(context.requestId)
          releaseRequest()
        }
      }
      if (!mounted.current) {
        operation.release()
        return operation
      }
      ownedOperations.current.set(context.requestId, operation)
      dispatch({
        type: 'begin',
        record: {
          ...context,
          labelKey,
          detail: normalizeOperationDetail(detail),
          status: 'running',
          startedAt: Date.now()
        }
      })
      return operation
    },
    []
  )

  const finishOperation = useCallback(
    (operation: ActiveOperation, succeeded: boolean, detail: string | OperationDetail) => {
      if (mounted.current && ownedOperations.current.get(operation.context.requestId) === operation) {
        dispatch({
          type: 'finish',
          requestId: operation.context.requestId,
          succeeded,
          detail: normalizeOperationDetail(detail),
          durationMs: Math.round(performance.now() - operation.startedAt)
        })
      }
      operation.release()
    },
    []
  )

  const clearCompleted = useCallback(() => dispatch({ type: 'clearCompleted' }), [])

  useEffect(() => {
    mounted.current = true
    const lifecycle = generation.current
    const currentGeneration = ++lifecycle.value
    const updateRequests = () => dispatch({ type: 'requests', activeRequests: getActiveOperationRequests() })
    const unsubscribe = subscribeOperationRequests(updateRequests)
    // Subscribe first: include requests that started before this effect, without an observation gap.
    updateRequests()
    const owned = ownedOperations.current
    return () => {
      mounted.current = false
      unsubscribe()
      // StrictMode replays effects synchronously. Only a real unmount releases root leases;
      // still-pending IPC calls keep their own leases until they settle.
      queueMicrotask(() => {
        if (lifecycle.value !== currentGeneration) return
        for (const operation of owned.values()) operation.release()
      })
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    return loreOperationStreamSubscription.subscribe((event) => {
      dispatch({ type: 'stream', event, receivedAt: Date.now() })
    })
  }, [enabled])

  return {
    operations: history.operations,
    loreOperationStreams: history.streams,
    activeRequests: history.activeRequests,
    activeCount: countActiveOperations(history.activeRequests),
    beginOperation,
    finishOperation,
    clearCompleted
  }
}
