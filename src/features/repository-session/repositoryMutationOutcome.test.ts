import { describe, expect, it } from 'vitest'

import type { RepositorySnapshot } from '../../types'
import { classifyRepositoryMutationOutcome } from './repositoryMutationOutcome'

function createSnapshot(conflict: boolean): RepositorySnapshot {
  return {
    repository: {
      id: 'repository-id',
      name: 'demo',
      branch: 'main',
      revision: 'current-revision',
      path: 'E:\\Repositories\\demo',
      ahead: 0,
      behind: 0,
      online: true,
      remoteState: 'online',
      color: '#78a4ff',
      conflictCount: conflict ? 1 : 0,
      unresolvedConflictCount: conflict ? 1 : 0
    },
    branches: [],
    revisions: [],
    changes: conflict
      ? [
          {
            id: 'Content/Conflict.txt',
            path: 'Content',
            name: 'Conflict.txt',
            status: 'modified',
            staged: true,
            additions: 0,
            deletions: 0,
            binary: false,
            conflict: true,
            conflictUnresolved: true
          }
        ]
      : [],
    tags: [],
    conflictSession: conflict
      ? {
          kind: 'merge',
          currentRevision: 'current-revision',
          stagedRevision: 'staged-revision',
          incomingRevision: 'incoming-revision'
        }
      : null,
    loadedAt: '2026-07-25T00:00:00.000Z'
  }
}

describe('repository mutation outcome classification', () => {
  it('reports a newly started merge conflict and routes to local changes', () => {
    const outcome = classifyRepositoryMutationOutcome(createSnapshot(false), createSnapshot(true), 'history')

    expect(outcome).toEqual({
      kind: 'conflictStarted',
      tone: 'warning',
      nextView: 'changes'
    })
  })

  it('preserves the caller view and completion semantics while the same conflict session remains active', () => {
    const outcome = classifyRepositoryMutationOutcome(createSnapshot(true), createSnapshot(true), 'changes')

    expect(outcome).toEqual({
      kind: 'completed',
      tone: 'success',
      nextView: 'changes'
    })
  })
})
