import { describe, expect, it } from 'vitest'

import { browserUpdateDialogFixture, shouldUseBrowserUpdateDialogFixture } from './updateDialogFixture'

describe('browser update dialog fixture', () => {
  it('requires browser demo mode and the explicit query parameter', () => {
    expect(shouldUseBrowserUpdateDialogFixture('browser-demo', '?update-dialog-fixture=1')).toBe(true)
    expect(shouldUseBrowserUpdateDialogFixture('browser-demo', '')).toBe(false)
    expect(shouldUseBrowserUpdateDialogFixture('tauri', '?update-dialog-fixture=1')).toBe(false)
  })

  it('provides a complete available update without native resources', () => {
    expect(browserUpdateDialogFixture.phase).toBe('available')
    expect(browserUpdateDialogFixture.currentVersion).toBe('0.1.16')
    expect(browserUpdateDialogFixture.availableVersion).toBe('0.2.1')
    expect(browserUpdateDialogFixture.notes).toContain('## Changes')
    expect(browserUpdateDialogFixture.notes).toContain('[Lore Client repository]')
  })
})
