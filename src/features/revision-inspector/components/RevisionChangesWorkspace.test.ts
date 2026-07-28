import { describe, expect, it } from 'vitest'

import type { ChangeFile } from '../../../types'
import {
  createDefaultRevisionChangeSelection,
  isRevisionWorkspaceSelectionRequestCurrent
} from './RevisionChangesWorkspace'

describe('revision change default selection', () => {
  const firstChange: ChangeFile = {
    id: 'first-change',
    name: 'World.ts',
    path: 'Content',
    status: 'modified',
    staged: false,
    additions: 0,
    deletions: 0,
    binary: false
  }
  const treeFirstChange: ChangeFile = {
    ...firstChange,
    id: 'tree-first-change',
    name: 'Actor.ts',
    path: 'Actors'
  }

  it('selects the first changed file after a revision becomes ready', () => {
    expect(createDefaultRevisionChangeSelection([firstChange])).toEqual({
      selectedObjectIds: ['file:first-change'],
      primaryObjectId: 'file:first-change'
    })
  })

  it('keeps the selection empty when the revision has no changed files', () => {
    expect(createDefaultRevisionChangeSelection([])).toEqual({
      selectedObjectIds: [],
      primaryObjectId: ''
    })
  })

  it('selects the first rendered file in tree view instead of the flat input head', () => {
    expect(createDefaultRevisionChangeSelection([firstChange, treeFirstChange], 'tree')).toEqual({
      selectedObjectIds: ['file:tree-first-change'],
      primaryObjectId: 'file:tree-first-change'
    })
  })

  it('rejects a stale file reveal request after switching repositories', () => {
    const request = {
      nonce: 1,
      repositoryPath: 'E:\\Repos\\previous',
      revisionId: 'revision-1',
      fileIds: ['Content/World.txt'],
      primaryFileId: 'Content/World.txt'
    }

    expect(isRevisionWorkspaceSelectionRequestCurrent(request, 'E:\\Repos\\current', 'revision-1')).toBe(false)
    expect(isRevisionWorkspaceSelectionRequestCurrent(request, 'E:\\Repos\\previous', 'revision-1')).toBe(true)
  })
})
