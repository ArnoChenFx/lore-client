import type {
  LoreOperationStreamRecord,
  OperationContext,
  OperationProgress,
  OperationProgressUnit,
  OperationRecord
} from '../../types'
import { isActiveOperationStream, isOperationRequestActive } from './operationHistory'

/** 超过该时长没有新快照就提示“可能卡住”：Rust 端只在数据变化时发快照，静默即无进展。 */
export const PROGRESS_STALL_MS = 15_000

/**
 * 暂存的进度事件名。暂存只有计数没有总量，文案要据此写成“已暂存 N 个文件”；
 * 按事件名而不是操作名判断，因为多个操作都会走到暂存。
 */
export const STAGE_PROGRESS_TAG = 'fileStageProgress'

/** 速率的指数平滑系数：越大越灵敏，越小越稳定。 */
const RATE_SMOOTHING = 0.3

const PROGRESS_UNITS: readonly OperationProgressUnit[] = ['files', 'bytes', 'fragments']

function nonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * 校验 Rust 归一化后的进度载荷。
 *
 * 形状不符时返回 undefined，调用方不得猜测字段：旧版本事件、其他操作的普通摘要都会走这里。
 */
export function parseOperationProgress(data: Record<string, unknown> | undefined): OperationProgress | undefined {
  const unit = PROGRESS_UNITS.find((candidate) => candidate === data?.unit)
  const current = nonNegative(data?.current)
  if (!data || !unit || current === undefined) return undefined
  return {
    unit,
    current,
    total: nonNegative(data.total),
    totalFinal: data.totalFinal === true,
    files: nonNegative(data.files),
    filesTotal: nonNegative(data.filesTotal),
    bytes: nonNegative(data.bytes),
    bytesTotal: nonNegative(data.bytesTotal),
    stepIndex: nonNegative(data.stepIndex),
    stepCount: nonNegative(data.stepCount),
    elapsedMs: nonNegative(data.elapsedMs) ?? 0
  }
}

/**
 * 由相邻两个快照估算主指标速率（单位 / 秒）。
 *
 * 单位或步骤变化意味着度量口径变了（例如总量定稿后由文件数切到字节数），旧速率不可比，
 * 直接放弃；时钟没有前进或数值回退时沿用旧值。
 */
export function nextProgressRate(
  previous: OperationProgress | undefined,
  previousRate: number | undefined,
  next: OperationProgress
): number | undefined {
  if (!previous || previous.unit !== next.unit || previous.stepIndex !== next.stepIndex) return undefined
  const seconds = (next.elapsedMs - previous.elapsedMs) / 1_000
  const delta = next.current - previous.current
  if (seconds <= 0 || delta < 0) return previousRate
  const instant = delta / seconds
  return previousRate === undefined ? instant : previousRate + RATE_SMOOTHING * (instant - previousRate)
}

/** 当前应显示在状态栏上的流：仍在进行、已有归一化进度，多个时取最近开始的一个。 */
export function selectActiveProgressRecord(
  records: readonly LoreOperationStreamRecord[],
  activeRequests: readonly OperationContext[],
  workspaceKey: string | null
): LoreOperationStreamRecord | null {
  let selected: LoreOperationStreamRecord | null = null
  for (const record of records) {
    if (record.workspaceKey !== workspaceKey || !record.progress || !isActiveOperationStream(record, activeRequests))
      continue
    if (!selected || record.startedAt > selected.startedAt) selected = record
  }
  return selected
}

/** Progress labels belong to the selected request; another workspace or workflow cannot lend its label. */
export function selectActiveOperationRecord(
  operations: readonly OperationRecord[],
  activeRequests: readonly OperationContext[],
  workspaceKey: string | null,
  requestId?: string
): OperationRecord | null {
  let selected: OperationRecord | null = null
  for (const record of operations) {
    if (
      record.workspaceKey !== workspaceKey ||
      (requestId !== undefined && record.requestId !== requestId) ||
      !isOperationRequestActive(record, activeRequests)
    )
      continue
    if (!selected || record.startedAt > selected.startedAt) selected = record
  }
  return selected
}

export interface ProgressView {
  /** 0 到 1；null 表示不确定（暂存、总量仍在增长、推送准备阶段）。 */
  fraction: number | null
  /** 总量尚未定稿：数字只能当作“至少”。 */
  approximate: boolean
  stalled: boolean
  /** 距上一个快照到达已经过去的时间；停滞提示以它为准，而不是总耗时。 */
  idleMs: number
  /** 自操作开始的耗时：Rust 单调时钟加上快照到达后的墙钟间隔。 */
  elapsedMs: number
  rate: number | undefined
}

/** 纯函数：把流记录和“当前时间”折算成界面状态，便于脱离 React 测试。 */
export function deriveProgressView(record: LoreOperationStreamRecord, now: number): ProgressView | null {
  const progress = record.progress
  if (!progress) return null
  const sinceSnapshot = record.progressAt === undefined ? 0 : Math.max(0, now - record.progressAt)
  const total = progress.total
  const fraction =
    total !== undefined && total > 0 && progress.totalFinal ? Math.min(1, Math.max(0, progress.current / total)) : null
  return {
    fraction,
    approximate: total !== undefined && !progress.totalFinal,
    stalled: sinceSnapshot >= PROGRESS_STALL_MS,
    idleMs: sinceSnapshot,
    elapsedMs: progress.elapsedMs + sinceSnapshot,
    rate: record.progressRate
  }
}

/** `mm:ss`，超过一小时为 `h:mm:ss`。 */
export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(Math.max(0, elapsedMs) / 1_000)
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}
