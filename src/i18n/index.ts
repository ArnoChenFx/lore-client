import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import type { LanguagePreference } from '../types'
import enUS from './locales/en-US'
import zhCN from './locales/zh-CN'

/** 供测试与启动链路等待；资源已内联，初始化很快完成。 */
export const i18nReady = i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    'en-US': { translation: enUS }
  },
  lng: 'en-US',
  fallbackLng: 'zh-CN',
  supportedLngs: ['zh-CN', 'en-US'],
  defaultNS: 'translation',
  // React 已负责转义；插值里的仓库名/路径保持原样。
  interpolation: { escapeValue: false },
  returnNull: false,
  saveMissing: false
})

/** 与 client-preferences 同步活动语言；不在此处持久化。 */
export function setAppLanguage(language: LanguagePreference): void {
  if (i18n.resolvedLanguage === language || i18n.language === language) return
  void i18n.changeLanguage(language)
}

export function getAppLanguage(): LanguagePreference {
  const language = i18n.resolvedLanguage ?? i18n.language
  return language === 'en-US' ? 'en-US' : 'zh-CN'
}

/** 非 React 模块（如 lore 服务）使用同一 i18n 实例。 */
export const t = i18n.t.bind(i18n)

/** 原生 confirm 不会经过 React；传入已由 `t()` 生成的最终文案。 */
export function confirmLocalized(message: string): boolean {
  if (typeof window === 'undefined') return false
  return window.confirm(message)
}

export default i18n
