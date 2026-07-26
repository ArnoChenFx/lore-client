import { describe, expect, it } from 'vitest'

import { resolveSystemLanguagePreference } from './systemLanguage'

describe('default application language from the operating system', () => {
  it('uses Simplified Chinese for a Chinese system locale', () => {
    expect(resolveSystemLanguagePreference(['zh-CN'])).toBe('zh-CN')
    expect(resolveSystemLanguagePreference(['zh-Hans-CN'])).toBe('zh-CN')
    expect(resolveSystemLanguagePreference(['zh-TW', 'en-US'])).toBe('zh-CN')
    expect(resolveSystemLanguagePreference(['zh'])).toBe('zh-CN')
  })

  it('uses English for non-Chinese system locales', () => {
    expect(resolveSystemLanguagePreference(['en-US'])).toBe('en-US')
    expect(resolveSystemLanguagePreference(['en-GB'])).toBe('en-US')
    expect(resolveSystemLanguagePreference(['ja-JP'])).toBe('en-US')
    expect(resolveSystemLanguagePreference(['de-DE', 'fr-FR'])).toBe('en-US')
  })

  it('falls back to English when the locale cannot be detected', () => {
    expect(resolveSystemLanguagePreference([])).toBe('en-US')
    expect(resolveSystemLanguagePreference(['', '  '])).toBe('en-US')
  })

  it('supports locale tags containing underscores', () => {
    expect(resolveSystemLanguagePreference(['zh_CN'])).toBe('zh-CN')
    expect(resolveSystemLanguagePreference(['en_US'])).toBe('en-US')
  })
})
