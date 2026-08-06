import pierreDark from '@pierre/theme/pierre-dark'
import pierreLight from '@pierre/theme/pierre-light'
import { describe, expect, it } from 'vitest'

import { createLoreDiffTheme, LORE_DIFF_DARK_THEME, LORE_DIFF_LIGHT_THEME } from './diffThemes'

describe('lore diff themes', () => {
  it('softens the dark theme text and change colors', () => {
    const theme = createLoreDiffTheme(pierreDark, LORE_DIFF_DARK_THEME, {
      foreground: '#d4d4d4',
      added: '#76bd90',
      deleted: '#df7b73',
      modified: '#78a4ff',
      changedToken: '#d9b36a',
      insertedBackground: '#76bd901a',
      deletedBackground: '#df7b731a'
    })
    expect(theme.name).toBe(LORE_DIFF_DARK_THEME)
    // 正文不再接近纯白，红绿基色替换为应用功能色。
    expect(theme.colors?.['editor.foreground']).toBe('#d4d4d4')
    expect(theme.colors?.['gitDecoration.addedResourceForeground']).toBe('#76bd90')
    expect(theme.colors?.['gitDecoration.deletedResourceForeground']).toBe('#df7b73')
    expect(theme.colors?.['gitDecoration.modifiedResourceForeground']).toBe('#78a4ff')
    expect(theme.colors?.['diffEditor.insertedTextBackground']).toBe('#76bd901a')
    expect(theme.colors?.['diffEditor.deletedTextBackground']).toBe('#df7b731a')
  })

  it('softens the light theme text and change colors', () => {
    const theme = createLoreDiffTheme(pierreLight, LORE_DIFF_LIGHT_THEME, {
      foreground: '#3a3a36',
      added: '#267b46',
      deleted: '#b74338',
      modified: '#315fae',
      changedToken: '#8b5c09',
      insertedBackground: '#267b4626',
      deletedBackground: '#b7433826'
    })
    expect(theme.name).toBe(LORE_DIFF_LIGHT_THEME)
    // 正文不再接近纯黑，红绿基色替换为浅色应用功能色。
    expect(theme.colors?.['editor.foreground']).toBe('#3a3a36')
    expect(theme.colors?.['gitDecoration.addedResourceForeground']).toBe('#267b46')
    expect(theme.colors?.['gitDecoration.deletedResourceForeground']).toBe('#b74338')
    expect(theme.colors?.['gitDecoration.modifiedResourceForeground']).toBe('#315fae')
  })

  it('replaces diff token colors without touching other syntax colors', () => {
    const dark = createLoreDiffTheme(pierreDark, LORE_DIFF_DARK_THEME, {
      foreground: '#d4d4d4',
      added: '#76bd90',
      deleted: '#df7b73',
      modified: '#78a4ff',
      changedToken: '#d9b36a',
      insertedBackground: '#76bd901a',
      deletedBackground: '#df7b731a'
    })
    const byScope = new Map<string, string>()
    for (const token of dark.tokenColors ?? []) {
      const scopes = Array.isArray(token.scope) ? token.scope : [token.scope]
      for (const scope of scopes) {
        if (scope?.endsWith('.diff')) byScope.set(scope, token.settings.foreground ?? '')
      }
    }
    expect(byScope.get('markup.inserted.diff')).toBe('#76bd90')
    expect(byScope.get('markup.deleted.diff')).toBe('#df7b73')
    expect(byScope.get('markup.changed.diff')).toBe('#d9b36a')
    // 其它语法 token 保持内置主题原值，色板不被破坏。
    expect(dark.tokenColors?.length).toBe(pierreDark.tokenColors.length)
    const stringToken = dark.tokenColors?.find((token) => {
      const scopes = Array.isArray(token.scope) ? token.scope : [token.scope]
      return scopes.includes('string')
    })
    expect(stringToken?.settings.foreground).toBe('#5ecc71')
  })
})
