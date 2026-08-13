/**
 * Diffs 库文本正文与变更高亮的柔和主题。
 *
 * 内置 pierre-dark / pierre-light 面向通用编辑器：正文接近纯白（#fafafa）或
 * 纯黑（#0a0a0a），增删改基色也偏饱和（#07c480 / #ff2e3f），在高密度的 Lore
 * Diff 面板里对比过强。这里在保留内置语法色板的前提下，只调整正文前景、
 * 增删改基色与 diff token 颜色，注册为 lore-diff-dark / lore-diff-light 两个
 * 自定义主题，由 TextDiffView 按应用主题引用。
 *
 * 颜色值与应用 CSS 令牌保持一致：
 * - 暗色正文 #d4d4d4（柔化纯白），增/删/改使用 --success / --danger / 品牌蓝；
 * - 浅色正文 #3a3a36（柔化纯黑），增/删/改使用浅色 --success / --danger / --accent。
 *
 * 库通过主题的 gitDecoration.*ResourceForeground 生成 --pierre-*addition-color
 * 等行级基色，行背景用 color-mix 按固定比例混入；基色变柔和后行背景与行内
 * emphasis 高亮同步降噪，不再刺眼。
 */
import { registerCustomTheme } from '@pierre/diffs'
import type { ThemeRegistration } from '@pierre/diffs'
import pierreDark from '@pierre/theme/pierre-dark'
import pierreLight from '@pierre/theme/pierre-light'

/** TextDiffView 传给 Diffs 库的暗色自定义主题名。 */
export const LORE_DIFF_DARK_THEME = 'lore-diff-dark'
/** TextDiffView 传给 Diffs 库的浅色自定义主题名。 */
export const LORE_DIFF_LIGHT_THEME = 'lore-diff-light'

/** 单个主题需要调整的颜色集合，全部为 8 位或 6 位 hex。 */
interface DiffThemeAdjustments {
  /** 正文前景：暗色柔化纯白，浅色柔化纯黑。 */
  foreground: string
  /** 新增行基色（gitDecoration.added 与 markup.inserted.diff）。 */
  added: string
  /** 删除行基色（gitDecoration.deleted 与 markup.deleted.diff）。 */
  deleted: string
  /** 修改行基色（gitDecoration.modified）。 */
  modified: string
  /** markup.changed.diff 的柔和黄色。 */
  changedToken: string
  /** diffEditor.insertedTextBackground：新增行内强调背景。 */
  insertedBackground: string
  /** diffEditor.deletedTextBackground：删除行内强调背景。 */
  deletedBackground: string
}

const DARK_ADJUSTMENTS: DiffThemeAdjustments = {
  foreground: '#d4d4d4',
  added: '#76bd90',
  deleted: '#df7b73',
  modified: '#78a4ff',
  changedToken: '#d9b36a',
  insertedBackground: '#76bd901a',
  deletedBackground: '#df7b731a'
}

const LIGHT_ADJUSTMENTS: DiffThemeAdjustments = {
  foreground: '#3a3a36',
  added: '#267b46',
  deleted: '#b74338',
  modified: '#315fae',
  changedToken: '#8b5c09',
  insertedBackground: '#267b4626',
  deletedBackground: '#b7433826'
}

/** scope 可能是字符串或数组，统一按精确匹配判断。 */
function scopeMatches(scope: string | string[] | undefined, target: string): boolean {
  if (!scope) return false
  return (Array.isArray(scope) ? scope : [scope]).includes(target)
}

/**
 * 基于内置 pierre 主题克隆并调整正文与变更色。
 *
 * 内置主题对象在运行时被 Object.freeze，这里用 JSON 深克隆解除只读后修改；
 * 主题是纯 JSON 数据，克隆开销只在注册解析时发生一次。返回对象必须保留
 * 库校验要求的 name === 注册名。base 接受任意可 JSON 序列化的主题对象。
 */
export function createLoreDiffTheme(
  base: unknown,
  themeName: string,
  adjustments: DiffThemeAdjustments
): ThemeRegistration {
  const theme = JSON.parse(JSON.stringify(base)) as ThemeRegistration
  const colors = theme.colors ?? {}
  colors['editor.foreground'] = adjustments.foreground
  colors['foreground'] = adjustments.foreground
  colors['gitDecoration.addedResourceForeground'] = adjustments.added
  colors['gitDecoration.deletedResourceForeground'] = adjustments.deleted
  colors['gitDecoration.modifiedResourceForeground'] = adjustments.modified
  colors['diffEditor.insertedTextBackground'] = adjustments.insertedBackground
  colors['diffEditor.deletedTextBackground'] = adjustments.deletedBackground
  theme.tokenColors = (theme.tokenColors ?? []).map((token) => {
    const settings = { ...token.settings }
    if (scopeMatches(token.scope, 'markup.inserted.diff')) {
      settings.foreground = adjustments.added
    } else if (scopeMatches(token.scope, 'markup.deleted.diff')) {
      settings.foreground = adjustments.deleted
    } else if (scopeMatches(token.scope, 'markup.changed.diff')) {
      settings.foreground = adjustments.changedToken
    }
    return { ...token, settings }
  })
  return { ...theme, name: themeName }
}

/**
 * 把两个柔和主题注册到 Diffs 库的全局主题解析器。
 *
 * 模块加载时执行一次（ESM 单例）；重复注册由库内 DuplicateThemeError 保护，
 * 只输出一条错误日志并保持首次注册不变，不会污染后续渲染。
 */
export function ensureDiffThemesRegistered(): void {
  registerCustomTheme(LORE_DIFF_DARK_THEME, async () =>
    createLoreDiffTheme(pierreDark, LORE_DIFF_DARK_THEME, DARK_ADJUSTMENTS)
  )
  registerCustomTheme(LORE_DIFF_LIGHT_THEME, async () =>
    createLoreDiffTheme(pierreLight, LORE_DIFF_LIGHT_THEME, LIGHT_ADJUSTMENTS)
  )
}

ensureDiffThemesRegistered()
