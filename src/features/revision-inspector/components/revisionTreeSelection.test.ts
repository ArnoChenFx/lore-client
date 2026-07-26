import { describe, expect, it } from 'vitest'

import type { RevisionFile } from '../../../types'
import { reconcileRevisionTreeSelection, type RevisionTreeSelectionState } from './revisionTreeSelection'

const firstFile: RevisionFile = {
  id: 'tree:first.txt',
  path: '.',
  name: 'first.txt',
  size: '1 B',
  binary: false
}

const targetFile: RevisionFile = {
  id: 'tree:target.txt',
  path: '.',
  name: 'target.txt',
  size: '1 B',
  binary: false
}

describe('revision file-tree selection reconciliation', () => {
  it('preserves the exact reveal target through repeated temporary tree reloads', () => {
    const locatedTarget = {
      selectedIds: [targetFile.id],
      primaryId: targetFile.id,
      anchorId: targetFile.id
    }

    let current: RevisionTreeSelectionState = locatedTarget
    for (let cycle = 0; cycle < 100; cycle += 1) {
      current = reconcileRevisionTreeSelection(false, [], current)
      current = reconcileRevisionTreeSelection(true, [firstFile, targetFile], current)
    }

    expect(current).toEqual(locatedTarget)
  })

  it('falls back to the first file only after a ready tree proves the old target is gone', () => {
    expect(
      reconcileRevisionTreeSelection(true, [firstFile], {
        selectedIds: [targetFile.id],
        primaryId: targetFile.id,
        anchorId: targetFile.id
      })
    ).toEqual({
      selectedIds: [firstFile.id],
      primaryId: firstFile.id,
      anchorId: firstFile.id
    })
  })
})
