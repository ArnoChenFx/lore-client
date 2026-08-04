import { describe, expect, it } from 'vitest'

import { appOverlayStateReducer, initialAppOverlayState, isCommandPaletteShortcut } from './useAppOverlayState'

const keyboardShortcut = (
  key: string,
  modifiers: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>> = {}
) =>
  isCommandPaletteShortcut({
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers
  })

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

  it('opens the command palette with Ctrl or Command plus P', () => {
    expect(keyboardShortcut('p', { ctrlKey: true })).toBe(true)
    expect(keyboardShortcut('P', { metaKey: true })).toBe(true)
  })

  it('ignores browser, shifted, legacy, unmodified, and Alt-modified shortcuts', () => {
    expect(keyboardShortcut('f', { ctrlKey: true })).toBe(false)
    expect(keyboardShortcut('p', { ctrlKey: true, shiftKey: true })).toBe(false)
    expect(keyboardShortcut('k', { ctrlKey: true })).toBe(false)
    expect(keyboardShortcut('p')).toBe(false)
    expect(keyboardShortcut('p', { ctrlKey: true, altKey: true })).toBe(false)
  })
})
