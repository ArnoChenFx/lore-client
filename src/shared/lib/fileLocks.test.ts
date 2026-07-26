import { describe, expect, it } from 'vitest'

import i18n from '../../i18n'
import { fileLockOwnerLabel, isUnidentifiedFileLockOwner } from './fileLocks'

describe('collaborative file lock owner display', () => {
  it('recognizes the empty and sentinel owner values returned by Lore', () => {
    expect(isUnidentifiedFileLockOwner('')).toBe(true)
    expect(isUnidentifiedFileLockOwner(' unknown ')).toBe(true)
    expect(isUnidentifiedFileLockOwner('<UNKNOWN>')).toBe(true)
  })

  it('preserves a real owner ID instead of guessing an account identity', () => {
    expect(isUnidentifiedFileLockOwner('artist@example.com')).toBe(false)
    expect(fileLockOwnerLabel('  artist@example.com  ')).toBe('artist@example.com')
  })

  it('localizes an unidentified owner at render time', async () => {
    await i18n.changeLanguage('zh-CN')
    expect(fileLockOwnerLabel('<unknown>')).toBe('未识别所有者')

    await i18n.changeLanguage('en-US')
    expect(fileLockOwnerLabel('<unknown>')).toBe('Unidentified owner')
  })
})
