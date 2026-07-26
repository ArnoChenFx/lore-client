import type { LanguagePreference } from '../types'

/**
 * 根据操作系统 / 浏览器语言标签解析首次启动默认界面语言。
 *
 * 只支持 `zh-CN` 与 `en-US`：任意中文标签（含繁体）映射到简体中文产品文案；
 * 其余可识别语言映射到英文。探测失败时回退英文。
 */
export function resolveSystemLanguagePreference(
  languages: readonly string[] = readNavigatorLanguages()
): LanguagePreference {
  const normalized = languages
    .map((tag) => tag.trim().toLowerCase().replaceAll('_', '-'))
    .filter((tag) => tag.length > 0)

  if (normalized.some((tag) => tag === 'zh' || tag.startsWith('zh-'))) {
    return 'zh-CN'
  }
  return 'en-US'
}

function readNavigatorLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return []
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
    return navigator.languages
  }
  return navigator.language ? [navigator.language] : []
}
