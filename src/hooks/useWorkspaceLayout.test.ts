import { describe, expect, it } from 'bun:test'

import { DEFAULT_WORKSPACE_LAYOUT, workspaceLayoutReducer, type WorkspaceLayoutState } from './useWorkspaceLayout'

function initialState(): WorkspaceLayoutState {
  const layout = { ...DEFAULT_WORKSPACE_LAYOUT }
  return { layout, committedLayout: layout }
}

describe('workspace layout commit boundaries', () => {
  it('updates the drag preview without broadcasting preferences until the final commit', () => {
    let state = initialState()
    const saved = state.committedLayout
    for (let width = 250; width <= 350; width += 1) {
      state = workspaceLayoutReducer(state, { type: 'sidebar', width, containerWidth: 1600, commit: false })
      expect(state.committedLayout).toBe(saved)
    }
    expect(state.layout.sidebarWidth).toBe(350)

    const preview = state.layout
    state = workspaceLayoutReducer(state, { type: 'sidebar', width: 350, containerWidth: 1600, commit: true })
    expect(state.layout).toBe(preview)
    expect(state.committedLayout).toBe(preview)
    expect(workspaceLayoutReducer(state, { type: 'sidebar', width: 350, containerWidth: 1600, commit: true })).toBe(
      state
    )
  })

  it('commits the clamped inspector size and retains the center minimum during drag', () => {
    const state = workspaceLayoutReducer(initialState(), {
      type: 'inspector',
      width: 2000,
      containerWidth: 1200,
      commit: false
    })
    expect(state.layout.inspectorWidth).toBe(606)
    expect(state.committedLayout.inspectorWidth).toBe(520)
    const final = workspaceLayoutReducer(state, { type: 'inspector', width: 2000, containerWidth: 1200, commit: true })
    expect(final.committedLayout.inspectorWidth).toBe(606)
  })

  it('commits keyboard changes, resets, hydration and window fitting without a pointer session', () => {
    let state = workspaceLayoutReducer(initialState(), {
      type: 'sidebar',
      width: 280,
      containerWidth: 1600,
      commit: true
    })
    expect(state.committedLayout.sidebarWidth).toBe(280)
    state = workspaceLayoutReducer(state, { type: 'reset', containerWidth: 1600 })
    expect(state.committedLayout).toEqual(DEFAULT_WORKSPACE_LAYOUT)
    state = workspaceLayoutReducer(state, {
      type: 'hydrate',
      layout: { sidebarWidth: 300, inspectorWidth: 800 },
      containerWidth: 1600
    })
    expect(state.committedLayout).toEqual({ sidebarWidth: 300, inspectorWidth: 800 })
    state = workspaceLayoutReducer(state, { type: 'fit', containerWidth: 1000 })
    expect(state.committedLayout).toEqual({ sidebarWidth: 300, inspectorWidth: 350 })
  })
})
