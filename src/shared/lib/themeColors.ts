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
 * 项目 Tab 可手动选择的 5×5 颜色矩阵。
 *
 * 25 个颜色分别代表独立的类别色，不再用同一色相的明暗变体填充一整行。
 * 排列顺序按色轮将相近颜色集中为暖色、黄绿、青蓝、蓝紫和紫粉五组，方便
 * 用户先定位颜色家族再选择具体颜色；原有五种自动类别色仍包含在矩阵中，
 * 因此已有自定义偏好与自动分配顺序保持兼容。
 */
export const REPOSITORY_TAB_COLOR_MATRIX = [
  ['#df5a5a', '#d87568', '#e47a3f', '#c8943c', '#9b684a'],
  ['#d6a92f', '#858d3a', '#91b83e', '#43a866', '#36ad84'],
  ['#69b99b', '#4aa7ad', '#39b6c8', '#3a8395', '#4aa1dc'],
  [BRAND_ACCENT_COLOR, '#4f78d1', '#49648f', '#5d61c9', '#a277bd'],
  ['#985bc1', '#80517f', '#c458b7', '#df6292', '#c94e6d']
] as const

export type RepositoryAccentColor = (typeof REPOSITORY_TAB_COLOR_MATRIX)[number][number]

const REPOSITORY_TAB_COLORS = REPOSITORY_TAB_COLOR_MATRIX.flat() as readonly RepositoryAccentColor[]

/** 在偏好边界拒绝任意 CSS 值，只接受产品审计过的小面积类别色。 */
export function isRepositoryAccentColor(value: unknown): value is RepositoryAccentColor {
  return typeof value === 'string' && REPOSITORY_TAB_COLORS.includes(value as RepositoryAccentColor)
}

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
