import type { LoreOperationStreamEvent, LoreOperationStreamRecord } from '../../types'
import { selectRecentOperationHistory } from './operationHistory'
import { nextProgressRate, parseOperationProgress } from './operationProgress'

/**
 * 将高频回调压缩为操作中心可消费的轻量记录，不保留补丁或二进制事件载荷。
 *
 * `now` 是事件到达页面的墙钟时间，必须由调用方在 dispatch 时取得：reducer 可能被重放或与别的
 * 更新合并执行，在这里读时钟会让“停滞多久”和速率随渲染时机漂移。
 */
export function mergeLoreOperationStream(
  records: LoreOperationStreamRecord[],
  incoming: LoreOperationStreamEvent,
  now: number
): LoreOperationStreamRecord[] {
  const existing = records.find((record) => record.operationId === incoming.operationId)
  const data = incoming.event?.data
  const metric = (key: string) => {
    const value = data?.[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }
  const progress = parseOperationProgress(data)
  const next: LoreOperationStreamRecord = {
    requestId: incoming.requestId,
    workspaceKey: incoming.workspaceKey,
    operationId: incoming.operationId,
    operation: incoming.operation,
    phase: incoming.phase,
    startedAt: existing?.startedAt ?? now,
    durationMs: incoming.durationMs ?? existing?.durationMs,
    eventCount: (existing?.eventCount ?? 0) + (incoming.event ? 1 : 0),
    lastEventTag: incoming.event?.tagName ?? existing?.lastEventTag,
    current: metric('current') ?? metric('processed') ?? existing?.current,
    total: metric('total') ?? metric('count') ?? existing?.total,
    bytes: metric('bytes') ?? metric('size') ?? existing?.bytes,
    progress: progress ?? existing?.progress,
    progressAt: progress ? now : existing?.progressAt,
    progressRate: progress
      ? nextProgressRate(existing?.progress, existing?.progressRate, progress)
      : existing?.progressRate,
    cancellable: incoming.cancellable
  }
  return selectRecentOperationHistory(
    [],
    [next, ...records.filter((record) => record.operationId !== incoming.operationId)]
  ).streams
}
