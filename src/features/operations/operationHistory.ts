import type { LoreOperationStreamRecord, OperationRecord } from '../../types'

/** 操作中心最多保留的已完成记录数量；活跃任务不受历史上限影响。 */
export const MAX_OPERATION_HISTORY = 200

/** 排队和流式进度也属于尚未完成的任务。 */
export function isActiveOperationStream(record: LoreOperationStreamRecord): boolean {
  return record.phase === 'queued' || record.phase === 'running' || record.phase === 'streaming'
}

/**
 * 从普通操作与 Lore 实时流中选择全局最新的记录。
 *
 * 仅裁剪已完成记录；活跃任务必须保留身份和已累积的进度，直到收到完成事件。
 * 两类已完成记录按统一开始时间选择最新 200 条，返回值仍保留各自原有顺序。
 */
export function selectRecentOperationHistory(operations: OperationRecord[], streams: LoreOperationStreamRecord[]) {
  const selected = [
    ...operations
      .filter((record) => record.status !== 'running')
      .map((record) => ({ kind: 'operation' as const, key: record.id, startedAt: record.startedAt })),
    ...streams
      .filter((record) => !isActiveOperationStream(record))
      .map((record) => ({ kind: 'stream' as const, key: record.operationId, startedAt: record.startedAt }))
  ]
    .sort((left, right) => right.startedAt - left.startedAt)
    .slice(0, MAX_OPERATION_HISTORY)

  const operationIds = new Set(
    selected.filter((record) => record.kind === 'operation').map((record) => record.key as number)
  )
  const streamIds = new Set(selected.filter((record) => record.kind === 'stream').map((record) => record.key as string))

  return {
    operations: operations.filter((record) => record.status === 'running' || operationIds.has(record.id)),
    streams: streams.filter((record) => isActiveOperationStream(record) || streamIds.has(record.operationId))
  }
}
