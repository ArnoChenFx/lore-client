import type { LoreOperationStreamRecord, OperationContext, OperationRecord } from '../../types'

/** Completed requests share one history budget; every stage of a live request stays available. */
export const MAX_OPERATION_HISTORY = 200

export function isOperationRequestActive(
  context: OperationContext,
  activeRequests: readonly OperationContext[]
): boolean {
  return activeRequests.some(
    (active) => active.requestId === context.requestId && active.workspaceKey === context.workspaceKey
  )
}

export function isActiveStreamPhase(phase: LoreOperationStreamRecord['phase']): boolean {
  return phase === 'queued' || phase === 'running' || phase === 'streaming'
}

export function isActiveOperationStream(
  record: LoreOperationStreamRecord,
  activeRequests: readonly OperationContext[]
): boolean {
  return isActiveStreamPhase(record.phase) && isOperationRequestActive(record, activeRequests)
}

/** Keep live request stages together, including terminal children while their root continues. */
export function selectRecentOperationHistory(
  operations: OperationRecord[],
  streams: LoreOperationStreamRecord[],
  activeRequests: readonly OperationContext[]
) {
  const selected = [
    ...operations
      .filter((record) => !isOperationRequestActive(record, activeRequests))
      .map((record) => ({ kind: 'operation' as const, key: record.requestId, startedAt: record.startedAt })),
    ...streams
      .filter((record) => !isOperationRequestActive(record, activeRequests))
      .map((record) => ({ kind: 'stream' as const, key: record.operationId, startedAt: record.startedAt }))
  ]
    .sort((left, right) => right.startedAt - left.startedAt)
    .slice(0, MAX_OPERATION_HISTORY)
  const operationIds = new Set(selected.filter((record) => record.kind === 'operation').map((record) => record.key))
  const streamIds = new Set(selected.filter((record) => record.kind === 'stream').map((record) => record.key))
  return {
    operations: operations.filter(
      (record) => isOperationRequestActive(record, activeRequests) || operationIds.has(record.requestId)
    ),
    streams: streams.filter(
      (record) => isOperationRequestActive(record, activeRequests) || streamIds.has(record.operationId)
    )
  }
}
