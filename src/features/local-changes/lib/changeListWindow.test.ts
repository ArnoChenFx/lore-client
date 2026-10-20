import { describe, expect, it } from 'bun:test'

import { changeListOffsets, changeListTabTargets, changeListWindow } from './changeListWindow'

describe('local change list window', () => {
  it('uses measured row sizes and retains a focused row outside the viewport', () => {
    const rows = Array.from({ length: 1000 }, (_, index) => ({
      id: String(index),
      kind: index % 10 === 0 ? ('directory' as const) : ('file' as const)
    }))
    const offsets = changeListOffsets(
      rows,
      new Map([
        ['1', 80],
        ['500', 55]
      ])
    )
    expect(offsets[2]).toBe(109)
    const indices = changeListWindow(offsets, offsets[500], 300, 1)
    expect(indices).toContain(1)
    expect(indices).toContain(500)
    expect(indices).toContain(501)
    expect(indices).not.toContain(400)
    expect(indices.length).toBeLessThan(40)
    const withTabBoundaries = changeListWindow(offsets, offsets[500], 300, 1, [0, 999])
    expect(withTabBoundaries[0]).toBe(0)
    expect(withTabBoundaries.at(-1)).toBe(999)
    expect(withTabBoundaries.length).toBeLessThan(42)
  })

  it('clamps a previous scroll position after filtering or collapsing the list', () => {
    const offsets = changeListOffsets(
      Array.from({ length: 12 }, (_, index) => ({ id: String(index), kind: 'file' as const })),
      new Map()
    )
    expect(changeListWindow(offsets, 50_000, 200)).toContain(11)
    expect(changeListWindow([0], 50_000, 200)).toEqual([])
  })

  it('keeps complete keyboard order for selected rows and directory toggles', () => {
    const rows = [
      { id: 'folder', kind: 'directory' as const },
      { id: 'first', kind: 'file' as const },
      { id: 'unselected', kind: 'file' as const },
      { id: 'last', kind: 'file' as const }
    ]
    expect(changeListTabTargets(rows, new Set(['folder', 'first', 'last']))).toEqual([
      { id: 'folder', toggle: false },
      { id: 'folder', toggle: true },
      { id: 'first', toggle: false },
      { id: 'last', toggle: false }
    ])
  })
})
