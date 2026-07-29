import { describe, expect, it } from 'vitest'

import type { ChangeFile } from '../../types'
import {
  buildChangeTreeRows,
  clampStageSplitRatio,
  changeDirectoryObjectId,
  changeFileOperationPaths,
  changeFilePath,
  changeFilePathTransition,
  changeFileObjectId,
  resolveSelectedChangeFiles,
  selectChangeContext,
  selectChangeFile
} from './changeTreeModel'

const files: ChangeFile[] = [
  {
    id: 'content-a',
    path: 'Content/World',
    name: 'A.txt',
    status: 'modified',
    staged: false,
    additions: 1,
    deletions: 0
  },
  {
    id: 'content-b',
    path: 'Content/World/Sub',
    name: 'B.txt',
    status: 'added',
    staged: false,
    additions: 2,
    deletions: 0
  },
  {
    id: 'root',
    path: '.',
    name: 'README.md',
    status: 'modified',
    staged: false,
    additions: 1,
    deletions: 1
  }
]

describe('local changes tree projection', () => {
  it('builds directory levels and hides collapsed descendants while preserving their IDs', () => {
    const expanded = buildChangeTreeRows(files, new Set())
    expect(expanded.map((row) => row.path)).toEqual([
      'Content',
      'Content/World',
      'Content/World/Sub',
      'Content/World/Sub/B.txt',
      'Content/World/A.txt',
      'README.md'
    ])

    const collapsed = buildChangeTreeRows(files, new Set(['Content/World']))
    const world = collapsed.find((row) => row.path === 'Content/World')
    expect(world?.descendantIds.sort()).toEqual(['content-a', 'content-b'])
    expect(collapsed.some((row) => row.path.endsWith('A.txt'))).toBe(false)
  })

  it('does not prefix root file paths with an extra dot', () => {
    expect(changeFilePath(files[2])).toBe('README.md')
  })

  it('distinguishes an exact rename from a cross-directory move', () => {
    expect(
      changeFilePathTransition({
        ...files[0],
        id: 'renamed-file',
        path: 'Content/World',
        name: 'WorldSettings.txt',
        status: 'renamed',
        previousPath: 'Content/World/A.txt'
      })
    ).toEqual({
      sourcePath: 'Content/World/A.txt',
      targetPath: 'Content/World/WorldSettings.txt',
      kind: 'renamed'
    })

    expect(
      changeFilePathTransition({
        ...files[0],
        id: 'moved-file',
        path: 'Content/Config',
        name: 'A.txt',
        status: 'renamed',
        previousPath: 'Content/World/A.txt'
      })
    ).toEqual({
      sourcePath: 'Content/World/A.txt',
      targetPath: 'Content/Config/A.txt',
      kind: 'moved'
    })
  })

  it('does not infer a path transition without an exact source path', () => {
    expect(
      changeFilePathTransition({
        ...files[0],
        id: 'source-missing',
        status: 'renamed'
      })
    ).toBeNull()
    expect(
      changeFilePathTransition({
        ...files[0],
        id: 'ordinary-add',
        status: 'added',
        previousPath: 'Content/World/Old.txt'
      })
    ).toBeNull()
  })

  it('expands both sides of a move for stage operations', () => {
    expect(
      changeFileOperationPaths([
        {
          ...files[0],
          id: 'moved-file',
          path: 'Content/Config',
          name: 'A.txt',
          status: 'renamed',
          previousPath: 'Content/World/A.txt'
        },
        files[2]
      ])
    ).toEqual(['Content/World/A.txt', 'Content/Config/A.txt', 'README.md'])
  })
})

describe('local changes multi-selection', () => {
  const order = ['a', 'b', 'c', 'd']

  it('supports ordinary clicks and Ctrl-based addition or removal', () => {
    expect(
      selectChangeFile(order, ['a'], 'b', 'a', {
        toggle: false,
        range: false
      }).selectedIds
    ).toEqual(['b'])
    expect(
      selectChangeFile(order, ['a'], 'b', 'a', {
        toggle: true,
        range: false
      }).selectedIds
    ).toEqual(['a', 'b'])
    expect(
      selectChangeFile(order, ['a', 'b'], 'b', 'a', {
        toggle: true,
        range: false
      }).selectedIds
    ).toEqual(['a'])
  })

  it('supports contiguous Shift ranges from an anchor', () => {
    expect(
      selectChangeFile(order, ['b'], 'd', 'b', {
        toggle: false,
        range: true
      }).selectedIds
    ).toEqual(['b', 'c', 'd'])
  })

  it('promotes a right-clicked non-primary item while preserving the existing multi-selection', () => {
    expect(selectChangeContext(['a', 'b', 'c'], 'a')).toEqual({
      selectedIds: ['a', 'b', 'c'],
      primaryId: 'a',
      anchorId: 'a'
    })
    expect(selectChangeContext(['a', 'b', 'c'], 'd')).toEqual({
      selectedIds: ['d'],
      primaryId: 'd',
      anchorId: 'd'
    })
  })

  it('uses independent IDs for folders and files without deriving parent or child highlights', () => {
    const rows = buildChangeTreeRows(files, new Set(), 'unstaged')
    const objectOrder = rows.map((row) => row.id)
    const contentDirectory = changeDirectoryObjectId('unstaged', 'Content')
    const childFile = changeFileObjectId('content-a')

    const directorySelection = selectChangeFile(objectOrder, [], contentDirectory, null, {
      toggle: false,
      range: false
    })
    expect(directorySelection.selectedIds).toEqual([contentDirectory])
    expect(directorySelection.selectedIds).not.toContain(childFile)

    const fileSelection = selectChangeFile(objectOrder, [], childFile, null, { toggle: false, range: false })
    expect(fileSelection.selectedIds).toEqual([childFile])
    expect(fileSelection.selectedIds).not.toContain(contentDirectory)
  })

  it('uses a separate folder namespace for revision trees and workspace selections', () => {
    const revisionRows = buildChangeTreeRows(files, new Set(), 'revision')
    expect(revisionRows[0]?.id).toBe('directory:revision:Content')
    expect(revisionRows.map((row) => row.id)).not.toContain('directory:unstaged:Content')
  })

  it('keeps multiple folders independently selected and expands descendants only for actions', () => {
    const rows = buildChangeTreeRows(files, new Set(), 'unstaged')
    const objectOrder = rows.map((row) => row.id)
    const contentDirectory = changeDirectoryObjectId('unstaged', 'Content')
    const worldDirectory = changeDirectoryObjectId('unstaged', 'Content/World')
    const first = selectChangeFile(objectOrder, [], contentDirectory, null, { toggle: false, range: false })
    const multiple = selectChangeFile(objectOrder, first.selectedIds, worldDirectory, contentDirectory, {
      toggle: true,
      range: false
    })

    expect(multiple.selectedIds).toEqual([contentDirectory, worldDirectory])
    expect(resolveSelectedChangeFiles(multiple.selectedIds, files, rows).map((file) => file.id)).toEqual([
      'content-a',
      'content-b'
    ])
  })

  it('clamps the staging split ratio to preserve a usable height for both lists', () => {
    expect(clampStageSplitRatio(0.95, 400, 100)).toBe(0.75)
    expect(clampStageSplitRatio(0.05, 400, 100)).toBe(0.25)
    expect(clampStageSplitRatio(0.58, 400, 100)).toBe(0.58)
  })
})
