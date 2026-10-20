import type { TFunction } from 'i18next'

import type { Revision } from '../../types'

const timestampFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
})

function formatTimestamp(date: Date): string {
  const parts = timestampFormatter.formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}`
}

function formatRelativeTime(committedAt: number, now: number, translate: TFunction): string {
  const minutes = Math.max(0, Math.floor((now - committedAt) / 60_000))
  if (minutes < 1) return translate('status.justNow')
  if (minutes < 60) return translate('status.minutesAgo', { count: minutes })
  if (minutes < 1_440) return translate('status.hoursAgo', { count: Math.floor(minutes / 60) })
  return translate('status.daysAgo', { count: Math.floor(minutes / 1_440) })
}

/**
 * 只在展示边界生成文案。显式传入响应式 t 和当前时间，使 React Compiler 的
 * 缓存同样能观察语言/时钟变化。
 */
export function revisionPresentation(revision: Revision, translate: TFunction, now = Date.now()) {
  const description = translate('status.revisionLabel', { number: revision.revisionNumber, id: revision.shortId })
  const author = revision.author || translate('unknownAuthor')
  const date = revision.committedAt == null ? null : new Date(revision.committedAt)
  const validDate = date !== null && Number.isFinite(date.getTime()) ? date : null
  const timestamp = validDate ? formatTimestamp(validDate) : translate('unknownTime')
  const relativeTime = validDate ? formatRelativeTime(validDate.getTime(), now, translate) : translate('unknownTime')

  return {
    title: revision.title || description,
    description,
    author,
    initials: revision.initials || author.slice(0, 1).toLocaleUpperCase(),
    timestamp,
    shortTimestamp: validDate ? timestamp.slice(5, 16) : '',
    relativeTime,
    dateTime: validDate?.toISOString()
  }
}
