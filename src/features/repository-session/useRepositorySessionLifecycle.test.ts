import { describe, expect, it } from 'vitest'

import type { RepositorySnapshot } from '../../types'
import { repositoryPathsForPersistence, restoredActiveSnapshot } from './useRepositorySessionLifecycle'

function snapshot(id: string, path: string): RepositorySnapshot {
  return {
    repository: {
      id,
      name: id,
      path,
      branch: 'main',
      revision: `${id}-revision`,
      ahead: 0,
      behind: 0,
      online: true,
      remoteState: 'online',
      color: '#000000',
      conflictCount: 0,
      unresolvedConflictCount: 0
    },
    revisions: [],
    branches: [],
    changes: [],
    tags: [],
    conflictSession: null,
    loadedAt: '2026-07-26T00:00:00.000Z'
  }
}

describe('repository session lifecycle', () => {
  it('restores the preferred repository by its saved path', () => {
    const first = snapshot('first', 'C:/first')
    const preferred = snapshot('preferred', 'C:/preferred')

    expect(restoredActiveSnapshot([first, preferred], 'C:/preferred')).toBe(preferred)
  })

  it('falls back to the first restored repository when the preferred path failed', () => {
    const first = snapshot('first', 'C:/first')

    expect(restoredActiveSnapshot([first], 'C:/missing')).toBe(first)
  })

  it('preserves unavailable paths without duplicating restored repositories', () => {
    const restored = snapshot('repository', 'C:/Repository')

    expect(repositoryPathsForPersistence([restored], ['c:/repository', 'D:/offline'])).toEqual([
      'C:/Repository',
      'D:/offline'
    ])
  })
})
