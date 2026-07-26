import type { LoreOperationStreamRecord, OperationRecord } from '../../types'

/** 操作中心最多保留和展示的近期记录数量，避免长会话持续累积状态。 */
export const MAX_OPERATION_HISTORY = 200

/**
 * 截断单一来源的操作记录。
 *
 * 调用方必须保证数组已经按“最新在前”排列；保留原数组可以避免未超限时触发
 * 不必要的 React 更新。
 */
export function limitRecentOperationRecords<T>(records: T[]): T[] {
  return records.length > MAX_OPERATION_HISTORY ? records.slice(0, MAX_OPERATION_HISTORY) : records
}

/**
 * 从普通操作与 Lore 实时流中选择全局最新的记录。
 *
 * 两类记录由不同回调产生，必须按统一开始时间裁剪，否则各保留 200 条会让操作中心
 * 实际展示 400 条。返回值保留各自原有顺序，便于操作中心继续分组展示实时流。
 */
export function selectRecentOperationHistory(
  operations: OperationRecord[],
  streams: LoreOperationStreamRecord[]
): {
  operations: OperationRecord[]
  streams: LoreOperationStreamRecord[]
} {
  const selected = [
    ...operations.map((record) => ({ kind: 'operation' as const, key: record.id, startedAt: record.startedAt })),
    ...streams.map((record) => ({ kind: 'stream' as const, key: record.operationId, startedAt: record.startedAt }))
  ]
    .sort((left, right) => right.startedAt - left.startedAt)
    .slice(0, MAX_OPERATION_HISTORY)

  const operationIds = new Set(
    selected.filter((record) => record.kind === 'operation').map((record) => record.key as number)
  )
  const streamIds = new Set(selected.filter((record) => record.kind === 'stream').map((record) => record.key as string))

  return {
    operations: operations.filter((record) => operationIds.has(record.id)),
    streams: streams.filter((record) => streamIds.has(record.operationId))
  }
}
