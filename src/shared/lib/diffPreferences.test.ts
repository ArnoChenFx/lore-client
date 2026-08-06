import { describe, expect, it } from 'vitest'

import type { DiffPreferences } from '../../types'
import { createDiffReadPreferencesKey } from './diffPreferences'

const basePreferences: DiffPreferences = {
  contextLines: 3,
  diffStyle: 'unified',
  expandFullFile: false,
  ignoreWhitespaceEol: false,
  ignoreWhitespaceInline: false
}

describe('diff read preferences', () => {
  it('keeps the read request key stable for render-only option changes', () => {
    const key = createDiffReadPreferencesKey(basePreferences)

    expect(createDiffReadPreferencesKey({ ...basePreferences, diffStyle: 'split' })).toBe(key)
    expect(createDiffReadPreferencesKey({ ...basePreferences, expandFullFile: true })).toBe(key)
  })

  it('changes the read request key for Lore patch options', () => {
    const key = createDiffReadPreferencesKey(basePreferences)

    expect(createDiffReadPreferencesKey({ ...basePreferences, contextLines: 8 })).not.toBe(key)
    expect(createDiffReadPreferencesKey({ ...basePreferences, ignoreWhitespaceEol: true })).not.toBe(key)
    expect(createDiffReadPreferencesKey({ ...basePreferences, ignoreWhitespaceInline: true })).not.toBe(key)
  })
})
