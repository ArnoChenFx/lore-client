import { t } from '../../i18n'
import { formatBytes } from '../../shared/lib'
import type { OperationProgress } from '../../types'
import { STAGE_PROGRESS_TAG, formatElapsed, type ProgressView } from './operationProgress'

export interface ProgressText {
  /** 状态栏上的紧凑文本。 */
  summary: string
  /** 悬停提示：逐项列出计数、速率与耗时。 */
  detail: string
}

function count(value: number): string {
  return value.toLocaleString()
}

/** 总量未定稿时在数字后加“+”，避免把仍在增长的数当成最终总数。 */
function totalLabel(progress: OperationProgress): string {
  const total = progress.total ?? 0
  return progress.totalFinal ? count(total) : `${count(total)}+`
}

function primaryCounts(progress: OperationProgress): string | undefined {
  if (progress.total === undefined) return undefined
  const current = progress.unit === 'bytes' ? formatBytes(progress.current) : count(progress.current)
  const total = progress.unit === 'bytes' && progress.totalFinal ? formatBytes(progress.total) : totalLabel(progress)
  switch (progress.unit) {
    case 'bytes':
      return t('status.progressOfBytes', { current, total })
    case 'fragments':
      return t('status.progressOfFragments', { current, total })
    case 'files':
      return t('status.progressOfFiles', { current, total })
  }
}

/**
 * 把进度快照折算成用户可读文本；总量未知时只陈述已完成数量，绝不编造百分比。
 *
 * `tagName` 是流记录里最近一个事件的名字，用来区分“暂存的计数”和“还没有数字的准备阶段”。
 */
export function describeOperationProgress(
  tagName: string | undefined,
  progress: OperationProgress,
  view: ProgressView
): ProgressText {
  const percent = view.fraction === null ? undefined : `${Math.floor(view.fraction * 100)}%`
  const step =
    progress.stepCount !== undefined && progress.stepCount > 1 && progress.stepIndex !== undefined
      ? t('status.progressRevisionStep', { index: progress.stepIndex, count: progress.stepCount })
      : undefined
  const elapsed = formatElapsed(view.elapsedMs)

  let headline: string | undefined = percent
  if (headline === undefined) {
    if (progress.total !== undefined) headline = primaryCounts(progress)
    else if (tagName === STAGE_PROGRESS_TAG) {
      headline = t('status.progressStaged', { count: progress.current, value: count(progress.current) })
    } else headline = t('operationProgress.preparing')
  }

  const stalled = view.stalled ? t('status.progressStalled', { seconds: Math.round(view.idleMs / 1_000) }) : undefined
  // 停滞提示排在耗时之前：窗口过窄被省略号截断时，先丢掉的是耗时而不是警告。
  const summary = [step, headline, stalled, elapsed].filter(Boolean).join(' · ')

  const rate =
    view.rate !== undefined && progress.unit === 'bytes'
      ? t('status.progressRate', { rate: formatBytes(view.rate) })
      : undefined
  const files =
    progress.unit === 'bytes' && progress.files !== undefined && progress.filesTotal !== undefined
      ? t('status.progressOfFiles', { current: count(progress.files), total: count(progress.filesTotal) })
      : undefined
  const uploaded =
    progress.unit !== 'bytes' && progress.bytes !== undefined
      ? t('status.progressUploaded', { size: formatBytes(progress.bytes) })
      : undefined
  const detail = [step, primaryCounts(progress), files, uploaded, rate, elapsed].filter(Boolean).join(' · ')
  return { summary, detail }
}
