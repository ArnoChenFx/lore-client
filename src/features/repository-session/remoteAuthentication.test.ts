import { describe, expect, it } from 'vitest'

import type { RepositoryRemoteState, RepositorySnapshot } from '../../types'
import {
  collectRemoteAuthenticationTargets,
  projectPausedRepositoriesOffline,
  refreshRepositoryAuthenticationState,
  remoteServerKey,
  repositoryServerUrl
} from './remoteAuthentication'

function createSnapshot(
  id: string,
  name: string,
  remoteState: RepositoryRemoteState,
  remoteUrl = `lore://server:41337/${name}`
): RepositorySnapshot {
  return {
    repository: {
      id,
      name,
      branch: 'main',
      revision: 'revision-1',
      path: `E:\\${name}`,
      ahead: 0,
      behind: 0,
      online: remoteState === 'online',
      remoteState,
      color: '#78a4ff',
      remoteUrl,
      conflictCount: 0,
      unresolvedConflictCount: 0
    },
    branches: [],
    revisions: [],
    changes: [],
    tags: [],
    conflictSession: null,
    loadedAt: '2026-07-28T00:00:00.000Z'
  }
}

describe('remote authentication recovery model', () => {
  it('groups unauthorized repositories by server root', () => {
    const targets = collectRemoteAuthenticationTargets(
      [
        createSnapshot('one', 'alpha', 'unauthorized'),
        createSnapshot('two', 'beta', 'unauthorized'),
        createSnapshot('three', 'gamma', 'offline', 'lore://other:41337/gamma')
      ],
      new Set()
    )

    expect(targets).toEqual([
      {
        serverUrl: 'lore://server:41337',
        repositoryNames: ['alpha', 'beta']
      }
    ])
  })

  it('projects every repository on a paused server as offline without mutating the source', () => {
    const unauthorized = createSnapshot('one', 'alpha', 'unauthorized')
    const online = createSnapshot('two', 'beta', 'online')
    const local = createSnapshot('three', 'local', 'local', '')
    const snapshots = [unauthorized, online, local]
    const projected = projectPausedRepositoriesOffline(snapshots, new Set(['lore://server:41337']))

    expect(projected.map((snapshot) => snapshot.repository.remoteState)).toEqual(['offline', 'offline', 'local'])
    expect(projected[0]?.repository.online).toBe(false)
    expect(unauthorized.repository.remoteState).toBe('unauthorized')
    expect(online.repository.remoteState).toBe('online')
    expect(projected[2]).toBe(local)
  })

  it('normalizes legacy repository URLs and paused server keys', () => {
    expect(repositoryServerUrl({ remoteUrl: 'lore://EXAMPLE.test:41337/project' })).toBe('lore://EXAMPLE.test:41337')
    expect(remoteServerKey(' lore://EXAMPLE.test:41337/ ')).toBe('lore://example.test:41337')
  })

  it('releases every repository context before publishing refreshed snapshots', async () => {
    const first = createSnapshot('one', 'alpha', 'unauthorized')
    const second = createSnapshot('two', 'beta', 'unauthorized')
    const events: string[] = []
    const published: RepositorySnapshot[] = []

    const result = await refreshRepositoryAuthenticationState(
      [first, second],
      (snapshot) => {
        events.push(`publish:${snapshot.repository.id}`)
        published.push(snapshot)
      },
      {
        refreshContexts: async (repositoryPaths) => {
          events.push(`release:${repositoryPaths.join(',')}`)
        },
        loadSnapshot: async (repositoryPath) => {
          events.push(`load:${repositoryPath}`)
          const source = repositoryPath === first.repository.path ? first : second
          return {
            ...source,
            repository: { ...source.repository, online: true, remoteState: 'online' }
          }
        }
      }
    )

    expect(events[0]).toBe(`release:${first.repository.path},${second.repository.path}`)
    expect(events.slice(1, 3)).toEqual([`load:${first.repository.path}`, `load:${second.repository.path}`])
    expect(published.map((snapshot) => snapshot.repository.remoteState)).toEqual(['online', 'online'])
    expect(result).toEqual({ snapshots: published, failedCount: 0 })
  })
})
