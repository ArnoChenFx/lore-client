import { LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { LoreOperationStreamRecord } from '../../../types'
import { deriveProgressView } from '../operationProgress'
import { describeOperationProgress } from '../operationProgressText'
import { resolveLoreOperationLabel } from '../operationStreamLabels'

interface OperationProgressStatusProps {
  record: LoreOperationStreamRecord
  /** 动作语义的名称（如“推送分支”）；缺省时回落到 Lore 操作名。 */
  label?: string | null
  /** 当前时间，由调用方的定时器提供，便于测试与统一刷新节奏。 */
  now: number
}

/**
 * 状态栏中的操作进度片段。
 *
 * 总量已知时是确定进度条；未知（暂存、推送准备阶段、总量仍在增长）时是不确定条加计数，
 * 不显示百分比。`role="progressbar"` 在不确定时省略 `aria-valuenow`，读屏软件据此播报“进行中”。
 */
export function OperationProgressStatus({ record, label, now }: OperationProgressStatusProps) {
  const progress = record.progress
  const view = deriveProgressView(record, now)
  if (!progress || !view) return null

  const text = describeOperationProgress(record.lastEventTag, progress, view)
  const title = label ?? resolveLoreOperationLabel(record.operation)
  const percent = view.fraction === null ? undefined : Math.floor(view.fraction * 100)

  return (
    <span
      className={`statusbar__progress${view.stalled ? ' is-stalled' : ''}`}
      role="progressbar"
      aria-label={title}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={text.detail}
      title={`${title} · ${text.detail}`}
    >
      <LoaderCircle className="is-spinning" size={12} />
      <b>{title}</b>
      <i className={`statusbar__progress-track${percent === undefined ? ' is-indeterminate' : ''}`}>
        <i style={percent === undefined ? undefined : { width: `${percent}%` }} />
      </i>
      <small>{text.summary}</small>
    </span>
  )
}

/**
 * 只在存在进行中的进度时才每秒刷新，空闲时不占用定时器与重渲染。
 *
 * 重新激活后的第一秒内读数可能略旧；`deriveProgressView` 对负间隔取 0，所以只会让耗时
 * 暂时少走一秒，不会倒退或误报停滞。
 */
export function useProgressClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}
