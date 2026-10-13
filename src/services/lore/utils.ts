/** 与 Lore 事件和界面展示无关的纯工具：字段读取、路径规范化、格式化与颜色。 */
import { t } from '../../i18n'
import { repositoryAccentFromIndex } from '../../shared/lib'
import type { FileContentClassification, LoreEvent } from '../../types'

export const ZERO_HASH_PATTERN = /^0+$/

/** 行内文本读取与冲突解决写回的默认大小上限（与 Rust 适配层保持一致）。 */
export const DEFAULT_WORKSPACE_TEXT_LIMIT_BYTES = 2 * 1024 * 1024

/** 前端可下调文本预算，但不能绕过 Rust 与 IPC 共同采用的 2 MiB 硬上限。 */
export function normalizeWorkspaceTextLimit(maxBytes: number): number {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return DEFAULT_WORKSPACE_TEXT_LIMIT_BYTES
  return Math.min(Math.trunc(maxBytes), DEFAULT_WORKSPACE_TEXT_LIMIT_BYTES)
}

/** 使用 Unicode 码点顺序提供与系统区域设置无关的稳定字符串比较。 */
export function compareStableText(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

export function eventData(events: LoreEvent[], tagName: string): Record<string, unknown> | undefined {
  return events.find((event) => event.tagName === tagName)?.data
}

/** 清除 Windows 扩展路径前缀，仅改变展示/持久化形式，不改变目录语义。 */
export function normalizeDisplayPath(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) {
    return `\\\\${path.slice('\\\\?\\UNC\\'.length)}`
  }
  return path.startsWith('\\\\?\\') ? path.slice(4) : path
}

export function readMetadataValue(value: unknown): unknown {
  if (!isRecord(value)) {
    return value
  }
  return value.data
}

export function readString(value: unknown, fallback = ''): string {
  if (typeof value === 'string' && value) {
    return value
  }
  if (typeof value === 'number') {
    return String(value)
  }
  return fallback
}

/**
 * 读取 Lore 的可选展示文本，并过滤固定版本用于表达“无数据”的内部哨兵。
 * 当前只用于身份类标签；真实用户输入即使包含尖括号，也不会被宽泛规则误删。
 */
export function readKnownLoreLabel(value: unknown): string | undefined {
  const label = readString(value).trim()
  const normalized = label.toLowerCase()
  return label.length > 0 && normalized !== 'unknown' && normalized !== '<unknown>' ? label : undefined
}

/**
 * 把 Lore Revision 字段收敛为客户端稳定语义。
 *
 * 固定 Lore 版本使用任意长度的全零哈希表示“没有 Revision”；这里统一返回空串，
 * 让调用方沿用既有的可选 Revision 分支，而不必理解上游协议细节。
 */
export function readRevisionId(value: unknown): string {
  const revision = readString(value)
  return revision.length > 0 && /^0+$/.test(revision) ? '' : revision
}

export function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * 解析 Rust 返回的结构化内容分类；旧后端或异常字段只能降级为 unknown，不能恢复路径枚举。
 */
export function readFileContentClassification(
  value: unknown,
  fallbackSource: FileContentClassification['source']
): FileContentClassification {
  if (!isRecord(value)) {
    return { kind: 'unknown', source: fallbackSource }
  }
  const kind = readString(value.kind)
  const source = readString(value.source)
  const allowedKinds: FileContentClassification['kind'][] = ['text', 'binary', 'unknown']
  const allowedSources: FileContentClassification['source'][] = [
    'empty',
    'bom',
    'signature',
    'utf8',
    'utf16',
    'controlBytes',
    'invalidEncoding',
    'deferred',
    'unavailable',
    'changedDuringRead',
    'loreDiff'
  ]
  return {
    kind: allowedKinds.includes(kind as FileContentClassification['kind'])
      ? (kind as FileContentClassification['kind'])
      : 'unknown',
    source: allowedSources.includes(source as FileContentClassification['source'])
      ? (source as FileContentClassification['source'])
      : fallbackSource
  }
}

export function readBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === 'true'
}

/**
 * 区分 Lore 明确返回的 false/0 与字段缺失、null 或未知协议值。
 * `readBoolean` 负责投影真假，本函数只判断该真假是否拥有足够证据。
 */
export function isBooleanEvidence(value: unknown): boolean {
  return value === true || value === false || value === 1 || value === 0 || value === 'true' || value === 'false'
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stablePathId(path: string): string {
  let hash = 2_166_136_261
  for (const character of path.toLocaleLowerCase()) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16_777_619)
  }
  return `repo-${(hash >>> 0).toString(16)}`
}

export function colorFromText(text: string): string {
  const id = stablePathId(text)
  /*
   * 自动仓库颜色只从稳定的五种受控类别色中循环，不消费手动选择的 25 色矩阵，
   * 因而调整选择器不会改变既有仓库的自动颜色。颜色仅用于项目区分，在线状态
   * 和错误仍由 Repository.online 与结构化错误单独表达。
   */
  const index = Number.parseInt(id.slice(-2), 16)
  return repositoryAccentFromIndex(index)
}

export function formatBytes(bytes: number): string {
  if (!bytes) {
    return '0 B'
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1_024)), units.length - 1)
  return `${(bytes / 1_024 ** unitIndex).toFixed(unitIndex ? 1 : 0)} ${units[unitIndex]}`
}

export function formatDateTime(date: Date): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}`
}

export function formatRelativeTime(date: Date): string {
  const deltaMinutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60_000))
  if (deltaMinutes < 1) return t('status.justNow')
  if (deltaMinutes < 60) return t('status.minutesAgo', { count: deltaMinutes })
  if (deltaMinutes < 1_440) return t('status.hoursAgo', { count: Math.floor(deltaMinutes / 60) })
  return t('status.daysAgo', { count: Math.floor(deltaMinutes / 1_440) })
}
