import type { DiffPreferences } from '../../types'

/**
 * 会改变 Lore unified patch 内容的读取参数。
 *
 * `diffStyle` 与 `expandFullFile` 只影响现有 patch 的前端渲染，不能进入这个投影；
 * 否则切换布局或展开全文会错误地清空当前 Diff 并重新发起远程读取。
 */
export type DiffReadPreferences = Pick<
  DiffPreferences,
  'contextLines' | 'ignoreWhitespaceEol' | 'ignoreWhitespaceInline'
>

/** 用三个稳定标量创建读取参数，供 React memo 与服务层共用同一边界。 */
export function createDiffReadPreferences(
  contextLines: number,
  ignoreWhitespaceEol: boolean,
  ignoreWhitespaceInline: boolean
): DiffReadPreferences {
  return { contextLines, ignoreWhitespaceEol, ignoreWhitespaceInline }
}
