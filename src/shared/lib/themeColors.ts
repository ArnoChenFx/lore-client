/**
 * Lore Client 的固定品牌基色。
 *
 * 该值既用于 CSS 的 `--accent-solid`，也作为多仓库标签调色板的第一个颜色。
 * 选择与焦点语义始终使用该品牌色；仓库标签圆点仅作为项目类别标识，可以
 * 使用其它受控色相，但不得反过来影响交互状态色。
 */
export const BRAND_ACCENT_COLOR = '#78a4ff'

/**
 * 多仓库场景通过小面积圆点区分相邻项目。
 *
 * 调色板复用界面的受控类别色方向，避免随机彩虹色；这些颜色只表示不同项目，
 * 不表示在线、失败或选择状态，相关状态仍由独立语义色表达。
 */
export const REPOSITORY_ACCENT_PALETTE = [BRAND_ACCENT_COLOR, '#4aa7ad', '#d87568', '#c8943c', '#a277bd'] as const

/**
 * 将任意整数稳定映射到仓库类别色。
 *
 * 处理负数和非有限值是为了让调用方即使使用外部哈希或降级索引，也不会把
 * `undefined` 传到 CSS 自定义属性中，造成仓库状态点退回浏览器默认颜色。
 */
export function repositoryAccentFromIndex(index: number): string {
  const safeIndex = Number.isFinite(index) ? Math.trunc(index) : 0
  const normalizedIndex =
    ((safeIndex % REPOSITORY_ACCENT_PALETTE.length) + REPOSITORY_ACCENT_PALETTE.length) %
    REPOSITORY_ACCENT_PALETTE.length
  return REPOSITORY_ACCENT_PALETTE[normalizedIndex]
}
