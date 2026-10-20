/** The local change list keeps its full selection model while mounting only nearby rows. */
export interface ChangeListRowSize {
  id: string
  kind: 'file' | 'directory'
}

export function changeListOffsets(rows: readonly ChangeListRowSize[], measured: ReadonlyMap<string, number>) {
  const offsets = [0]
  for (const row of rows) {
    offsets.push(offsets.at(-1)! + (measured.get(row.id) ?? (row.kind === 'file' ? 36 : 29)))
  }
  return offsets
}

export function changeListWindow(
  offsets: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  focusedIndex = -1,
  tabBoundaryIndices: readonly number[] = []
): number[] {
  const count = offsets.length - 1
  if (count === 0) return []
  const top = Math.max(0, Math.min(scrollTop, offsets[count] - viewportHeight))
  const bottom = top + Math.max(viewportHeight, 360)
  const lowerBound = (position: number) => {
    let low = 0
    let high = count
    while (low < high) {
      const middle = (low + high) >>> 1
      if (offsets[middle + 1] <= position) low = middle + 1
      else high = middle
    }
    return low
  }
  const first = Math.max(0, lowerBound(top) - 6)
  const last = Math.min(count, lowerBound(bottom) + 7)
  const indices = Array.from({ length: last - first }, (_, index) => first + index)
  for (const index of [focusedIndex, ...tabBoundaryIndices]) {
    if (index >= 0 && index < count && !indices.includes(index)) indices.push(index)
  }
  indices.sort((left, right) => left - right)
  return indices
}

export function changeListTabTargets(rows: readonly ChangeListRowSize[], selectedIds: ReadonlySet<string>) {
  const targets: Array<{ id: string; toggle: boolean }> = []
  for (const row of rows) {
    if (selectedIds.has(row.id)) targets.push({ id: row.id, toggle: false })
    if (row.kind === 'directory') targets.push({ id: row.id, toggle: true })
  }
  return targets
}
