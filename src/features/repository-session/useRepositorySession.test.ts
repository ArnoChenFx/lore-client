import { describe, expect, it } from 'vitest'

import type { RepositorySnapshot } from '../../types'
import { repositorySelection, upsertRepositorySnapshot } from './useRepositorySession'

function snapshot(id: string, path: string, revision = `${id}-revision`): RepositorySnapshot {
  return {
    repository: {
      id,
      name: id,
      path,
      branch: 'main',
      revision,
      ahead: 0,
      behind: 0,
      online: true,
      remoteState: 'online',
      color: '#000000',
      conflictCount: 0,
      unresolvedConflictCount: 0
    },
    revisions: [],
    branches: [
      {
        id: `${id}-branch`,
        name: 'main',
        current: true,
        latest: revision,
        ahead: 0,
        remote: false,
        archived: false,
        author: 'Author'
      }
    ],
    changes: [],
    tags: [],
    conflictSession: null,
    loadedAt: '2026-07-26T00:00:00.000Z'
  }
}

describe('repository session controller', () => {
  it('derives all object selections from the activated snapshot', () => {
    const value = snapshot('repository', 'C:/repository')

    expect(repositorySelection(value)).toEqual({
      revisionId: 'repository-revision',
      branchId: 'repository-branch',
      tagId: ''
    })
  })

  it('keeps a repository copy at another local path as a separate session', () => {
    const original = snapshot('repository', 'C:/old')
    const refreshed = snapshot('repository', 'C:/new', 'revision-2')

    expect(upsertRepositorySnapshot([original], refreshed)).toEqual([original, refreshed])
  })

  it('keeps separate local workspaces when cloned repositories share one Lore ID', () => {
    const original = snapshot('shared-repository', 'E:/Game/godot/projects/test-lore-repo')
    const secondCopy = snapshot('shared-repository', 'E:/Game/godot/projects/test-lore-repo-remove')

    expect(upsertRepositorySnapshot([original], secondCopy)).toEqual([original, secondCopy])
  })

  it('replaces a reopened repository by path and preserves tab order', () => {
    const first = snapshot('first', 'C:/first')
    const unavailableRead = snapshot('temporary-id', 'C:/target')
    const reopened = snapshot('real-id', 'C:/target', 'revision-2')

    expect(upsertRepositorySnapshot([first, unavailableRead], reopened)).toEqual([first, reopened])
  })
})
