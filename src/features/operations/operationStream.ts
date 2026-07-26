import type { LoreOperationStreamEvent, LoreOperationStreamRecord } from '../../types'
import { limitRecentOperationRecords } from './operationHistory'

/** 将高频回调压缩为操作中心可消费的轻量记录，不保留补丁或二进制事件载荷。 */
export function mergeLoreOperationStream(
  records: LoreOperationStreamRecord[],
  incoming: LoreOperationStreamEvent
): LoreOperationStreamRecord[] {
  const existing = records.find((record) => record.operationId === incoming.operationId)
  const data = incoming.event?.data
  const metric = (key: string) => {
    const value = data?.[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }
  const next: LoreOperationStreamRecord = {
    operationId: incoming.operationId,
    operation: incoming.operation,
    phase: incoming.phase,
    startedAt: existing?.startedAt ?? Date.now(),
    durationMs: incoming.durationMs ?? existing?.durationMs,
    eventCount: (existing?.eventCount ?? 0) + (incoming.event ? 1 : 0),
    lastEventTag: incoming.event?.tagName ?? existing?.lastEventTag,
    current: metric('current') ?? metric('processed') ?? existing?.current,
    total: metric('total') ?? metric('count') ?? existing?.total,
    bytes: metric('bytes') ?? metric('size') ?? existing?.bytes,
    cancellable: incoming.cancellable
  }
  return limitRecentOperationRecords([next, ...records.filter((record) => record.operationId !== incoming.operationId)])
}
