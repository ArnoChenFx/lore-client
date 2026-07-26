import { describe, expect, it } from 'vitest'

import { appOverlayStateReducer, initialAppOverlayState } from './useAppOverlayState'

describe('application overlay state', () => {
  it('opens and closes one global overlay without changing the others', () => {
    const opened = appOverlayStateReducer(initialAppOverlayState, {
      type: 'set',
      key: 'searchOpen',
      open: true
    })
    expect(opened.searchOpen).toBe(true)
    expect(opened.settingsOpen).toBe(false)
    expect(appOverlayStateReducer(opened, { type: 'set', key: 'searchOpen', open: false }).searchOpen).toBe(false)
  })

  it('keeps the settings category independent from visibility', () => {
    const state = appOverlayStateReducer(initialAppOverlayState, {
      type: 'settingsCategory',
      category: 'integrations'
    })
    expect(state.settingsInitialCategory).toBe('integrations')
    expect(state.settingsOpen).toBe(false)
  })

  it('atomically closes settings before showing an available update', () => {
    const settingsOpen = { ...initialAppOverlayState, settingsOpen: true }
    const state = appOverlayStateReducer(settingsOpen, { type: 'showUpdate' })
    expect(state.settingsOpen).toBe(false)
    expect(state.updateDialogOpen).toBe(true)
  })
})
