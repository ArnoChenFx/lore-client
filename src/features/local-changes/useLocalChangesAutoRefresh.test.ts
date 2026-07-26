import { describe, expect, it } from 'vitest'

import { shouldAutoRefreshLocalChanges } from './useLocalChangesAutoRefresh'

describe('local changes automatic refresh', () => {
  it('enables disk refresh only for an opened desktop repository on local changes', () => {
    expect(shouldAutoRefreshLocalChanges('tauri', 'changes', 'C:/repository')).toBe(true)
  })

  it('disables disk refresh outside the local changes view', () => {
    expect(shouldAutoRefreshLocalChanges('tauri', 'history', 'C:/repository')).toBe(false)
  })

  it('disables disk refresh for browser demo and empty repository paths', () => {
    expect(shouldAutoRefreshLocalChanges('browser-demo', 'changes', 'C:/repository')).toBe(false)
    expect(shouldAutoRefreshLocalChanges('tauri', 'changes', '')).toBe(false)
  })
})
