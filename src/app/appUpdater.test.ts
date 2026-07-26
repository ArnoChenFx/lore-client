import { describe, expect, it } from 'vitest'

import { calculateUpdateProgress, isUpdateBusy } from './appUpdater'

describe('app updater state helpers', () => {
  it('keeps progress indeterminate until the server reports a valid total size', () => {
    expect(calculateUpdateProgress(10, null)).toBeNull()
    expect(calculateUpdateProgress(10, 0)).toBeNull()
  })

  it('clamps download progress to a valid percentage', () => {
    expect(calculateUpdateProgress(25, 100)).toBe(25)
    expect(calculateUpdateProgress(200, 100)).toBe(100)
    expect(calculateUpdateProgress(-20, 100)).toBe(0)
  })

  it('only treats native check and installation phases as busy', () => {
    expect(isUpdateBusy('checking')).toBe(true)
    expect(isUpdateBusy('downloading')).toBe(true)
    expect(isUpdateBusy('installing')).toBe(true)
    expect(isUpdateBusy('available')).toBe(false)
    expect(isUpdateBusy('error')).toBe(false)
  })
})
