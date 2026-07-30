import { describe, expect, it, vi } from 'vitest'

import type { RepositorySnapshot } from '../../types'
import {
  repositoryPathsForPersistence,
  restoreRepositorySession,
  restoredActiveSnapshot
} from './useRepositorySessionLifecycle'

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
  it('stops an obsolete restore generation before loading the next repository', async () => {
    let current = true
    let resolveFirstSnapshot: ((value: RepositorySnapshot) => void) | undefined
    const loadSnapshot = vi.fn(
      (path: string) =>
        new Promise<RepositorySnapshot>((resolve) => {
          if (path === 'C:/first') resolveFirstSnapshot = resolve
        })
    )
    const restore = restoreRepositorySession({
      loadPreferences: async () => ({
        repositoryPaths: ['C:/first', 'C:/second'],
        activeRepositoryPath: 'C:/first'
      }),
      loadSnapshot,
      isCurrent: () => current
    })

    await Promise.resolve()
    current = false
    resolveFirstSnapshot?.(snapshot('first', 'C:/first'))

    await expect(restore).resolves.toBeNull()
    expect(loadSnapshot).toHaveBeenCalledTimes(1)
  })

  it('keeps failed paths while restoring successful snapshots in saved order', async () => {
    const result = await restoreRepositorySession({
      loadPreferences: async () => ({
        repositoryPaths: ['C:/first', 'C:/offline', 'C:/second'],
        activeRepositoryPath: 'C:/second'
      }),
      loadSnapshot: async (path) => {
        if (path === 'C:/offline') throw new Error('offline')
        return snapshot(path === 'C:/first' ? 'first' : 'second', path)
      },
      isCurrent: () => true
    })

    expect(result?.restoredSnapshots.map((item) => item.repository.id)).toEqual(['first', 'second'])
    expect(result?.failedPaths).toEqual(['C:/offline'])
    expect(result?.storedPreferences.activeRepositoryPath).toBe('C:/second')
  })

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
