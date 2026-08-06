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

/** 从完整持久化偏好中提取唯一允许触发 Lore patch 重读的参数。 */
export function selectDiffReadPreferences(preferences: DiffPreferences): DiffReadPreferences {
  return createDiffReadPreferences(
    preferences.contextLines,
    preferences.ignoreWhitespaceEol,
    preferences.ignoreWhitespaceInline
  )
}

/**
 * 生成读取 effect 的稳定依赖键。
 *
 * 数字与布尔值采用固定字段顺序，不序列化渲染参数；这样测试可以直接锁定“展开全文
 * 不得重读 patch”的边界。组件使用同一组三个标量作为 memo 依赖，避免依赖完整
 * `DiffPreferences` 对象引用。
 */
export function createDiffReadPreferencesKey(preferences: DiffPreferences): string {
  const selected = selectDiffReadPreferences(preferences)
  return `${selected.contextLines}:${Number(selected.ignoreWhitespaceEol)}:${Number(selected.ignoreWhitespaceInline)}`
}
