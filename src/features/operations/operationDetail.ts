import { t } from '../../i18n'
import type { OperationDetail } from '../../types'

/** 路径、错误原文等与语言无关的操作详情。 */
export function operationText(text: string): OperationDetail {
  return { kind: 'text', text }
}

/** 可重译的操作详情；语言切换后由面板再次 `t()`。 */
export function operationMessage(key: string, values?: Record<string, unknown>): OperationDetail {
  return { kind: 'i18n', key, values }
}

export function normalizeOperationDetail(detail: string | OperationDetail): OperationDetail {
  return typeof detail === 'string' ? operationText(detail) : detail
}

/** Toast 与列表共用同一解析结果；列表会在切换语言时再次调用。 */
export function resolveOperationDetail(detail: OperationDetail): string {
  if (detail.kind === 'text') return detail.text
  return t(detail.key as never, detail.values)
}
