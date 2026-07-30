import { describe, expect, it } from 'vitest'

import type { RevisionFile } from '../../../types'
import {
  createEmptyRevisionTreeSelection,
  findRevisionTreePrimaryFile,
  reconcileRevisionTreeSelection,
  type RevisionTreeSelectionState
} from './revisionTreeSelection'

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
  it('starts a new Revision without a default file selection', () => {
    expect(createEmptyRevisionTreeSelection()).toEqual({ selectedIds: [], primaryId: '', anchorId: null })
    expect(findRevisionTreePrimaryFile([firstFile, targetFile], '')).toBeUndefined()
  })

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

  it('clears the selection after a ready tree proves the old target is gone', () => {
    expect(
      reconcileRevisionTreeSelection(true, [firstFile], {
        selectedIds: [targetFile.id],
        primaryId: targetFile.id,
        anchorId: targetFile.id
      })
    ).toEqual({ selectedIds: [], primaryId: '', anchorId: null })
  })

  it('promotes a retained explicit selection instead of falling back to the first file', () => {
    expect(
      reconcileRevisionTreeSelection(true, [firstFile, targetFile], {
        selectedIds: ['tree:missing.txt', targetFile.id],
        primaryId: 'tree:missing.txt',
        anchorId: 'tree:missing.txt'
      })
    ).toEqual({
      selectedIds: [targetFile.id],
      primaryId: targetFile.id,
      anchorId: targetFile.id
    })
  })
})
