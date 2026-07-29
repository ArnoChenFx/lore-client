import { describe, expect, it } from 'vitest'

import { LoreRepositoryPublishError } from '../../services/lore'
import {
  isRepositoryToolsBusy,
  findConnectedRemoteRepository,
  isPublishAuthenticationError,
  loadCurrentDependencyGraph,
  normalizeRepositoryToolPaths,
  projectRepositoryConfigurationSnapshot,
  resolvePublishAuthAccount
} from './useRepositoryToolsController'

describe('repository tools controller helpers', () => {
  it('normalizes duplicate and blank paths before a lock mutation', () => {
    expect(normalizeRepositoryToolPaths([' Content/A ', '', 'Content/B', 'Content/A', '   '])).toEqual([
      'Content/A',
      'Content/B'
    ])
  })

  it('keeps path order stable while removing duplicates', () => {
    expect(normalizeRepositoryToolPaths(['B', 'A', 'B', 'C'])).toEqual(['B', 'A', 'C'])
  })

  it('queries the staged dependency state after a dependency mutation', async () => {
    const selection = {
      rootFiles: ['sc/Fox.gltf'],
      tags: [],
      recursive: true,
      depthLimit: 0
    }
    const revisions: Array<string | undefined> = []

    const result = await loadCurrentDependencyGraph(
      'E:\\Project\\Lore',
      selection.rootFiles,
      selection,
      false,
      'immutable-revision',
      async (_repositoryPath, rootPaths, options, reverse, revision) => {
        revisions.push(revision)
        return {
          revision: revision ?? '',
          groups: [],
          nodes: rootPaths.map((path) => ({ path, distance: 0, root: true })),
          edges: [],
          reverse,
          recursive: options.recursive,
          depthLimit: options.depthLimit,
          truncated: false,
          nodeLimit: 240
        }
      }
    )

    // Lore 只有在 Revision 为空时才读取 dependency-add 写入的 staged anchor。
    expect(revisions).toEqual([undefined])
    // 图谱仍保留当前不可变 Revision 作为暂存状态的可读基线。
    expect(result.revision).toBe('immutable-revision')
  })

  it('finds the connected remote repository by stable repository ID', () => {
    expect(
      findConnectedRemoteRepository(
        [
          { id: 'other-id', name: 'project', description: 'Wrong repository' },
          { id: 'current-id', name: 'renamed-project', description: 'Current repository' }
        ],
        'current-id',
        'project'
      )
    ).toMatchObject({
      id: 'current-id',
      description: 'Current repository'
    })
  })

  it('falls back to the repository name for legacy directory entries', () => {
    expect(
      findConnectedRemoteRepository(
        [{ id: 'legacy-remote-id', name: 'project', description: 'Legacy repository' }],
        'missing-local-id',
        'project'
      )
    ).toMatchObject({
      name: 'project',
      description: 'Legacy repository'
    })
  })

  it('marks only repository-tool mutations as loading', () => {
    expect(isRepositoryToolsBusy('applyRepositoryView')).toBe(true)
    expect(isRepositoryToolsBusy('resetBranchLatest')).toBe(true)
    expect(isRepositoryToolsBusy('createRevision')).toBe(false)
    expect(isRepositoryToolsBusy(null)).toBe(false)
  })

  it('projects an authoritative configuration result without rebuilding unrelated snapshot data', () => {
    const activeSnapshot = {
      repository: {
        id: 'repository-id',
        name: 'project',
        branch: 'main',
        revision: 'revision-id',
        path: 'E:\\Project\\project',
        ahead: 1,
        behind: 2,
        online: true,
        remoteState: 'online' as const,
        color: '#78a4ff',
        conflictCount: 0,
        unresolvedConflictCount: 0
      },
      branches: [],
      revisions: [],
      changes: [],
      tags: [],
      conflictSession: null,
      loadedAt: '2026-07-29T00:00:00.000Z'
    }

    const projected = projectRepositoryConfigurationSnapshot(activeSnapshot, {
      identity: 'Arno <arno@example.com>',
      remoteUrl: 'lore://192.168.11.20:41337'
    })

    expect(projected.repository).toMatchObject({
      identity: 'Arno <arno@example.com>',
      remoteUrl: 'lore://192.168.11.20:41337',
      serverUrl: 'lore://192.168.11.20:41337',
      revision: 'revision-id',
      ahead: 1,
      behind: 2
    })
    expect(projected.branches).toBe(activeSnapshot.branches)
    expect(projected.revisions).toBe(activeSnapshot.revisions)
    expect(projected.changes).toBe(activeSnapshot.changes)
  })

  it('prefers the repository account binding when publishing', () => {
    expect(
      resolvePublishAuthAccount(
        'E:\\Game\\Project',
        [
          {
            repositoryPath: 'e:\\game\\project\\',
            authUrl: 'https://auth.example.com',
            userId: 'bound-user'
          }
        ],
        [
          {
            authUrl: 'https://auth.example.com',
            userId: 'other-user',
            authorizedDomains: [],
            resource: 'lore://example.com'
          }
        ]
      )
    ).toEqual({
      authUrl: 'https://auth.example.com',
      userId: 'bound-user',
      inferred: false
    })
  })

  it('uses and marks the only device account for automatic repository binding', () => {
    expect(
      resolvePublishAuthAccount(
        'E:\\Game\\Project',
        [],
        [
          {
            authUrl: 'https://auth.example.com',
            userId: 'only-user',
            authorizedDomains: [],
            resource: 'lore://example.com'
          }
        ]
      )
    ).toEqual({
      authUrl: 'https://auth.example.com',
      userId: 'only-user',
      inferred: true
    })
  })

  it('deduplicates multiple resource entries for the same publishing account', () => {
    expect(
      resolvePublishAuthAccount(
        'E:\\Game\\Project',
        [],
        [
          {
            authUrl: 'https://auth.example.com',
            userId: 'only-user',
            authorizedDomains: [],
            resource: ''
          },
          {
            authUrl: 'https://auth.example.com',
            userId: 'only-user',
            authorizedDomains: ['example.com'],
            resource: 'lore://example.com'
          }
        ]
      )
    ).toMatchObject({
      userId: 'only-user',
      inferred: true
    })
  })

  it('does not guess a publishing account when multiple device accounts are available', () => {
    expect(
      resolvePublishAuthAccount(
        'E:\\Game\\Project',
        [],
        [
          {
            authUrl: 'https://auth-a.example.com',
            userId: 'user-a',
            authorizedDomains: [],
            resource: 'lore://a.example.com'
          },
          {
            authUrl: 'https://auth-b.example.com',
            userId: 'user-b',
            authorizedDomains: [],
            resource: 'lore://b.example.com'
          }
        ]
      )
    ).toBeNull()
  })

  it('recognizes only the stable publishing authentication failure', () => {
    const createResult = {
      status: 1,
      operation: 'repository.create.remote',
      durationMs: 0,
      events: []
    }
    const authenticationError = new LoreRepositoryPublishError({
      repositoryUrl: 'lore://example.com/project',
      remoteCreated: false,
      remotePreexisting: false,
      requestedRemoteName: 'project',
      configurationUpdated: false,
      pushed: false,
      createResult,
      failureStage: 'remoteCreate',
      failureCode: 'auth_required'
    })
    const nameMismatchError = new LoreRepositoryPublishError({
      repositoryUrl: 'lore://example.com/project',
      remoteCreated: false,
      remotePreexisting: true,
      existingRemoteName: 'project',
      requestedRemoteName: 'project-renamed',
      configurationUpdated: false,
      pushed: false,
      createResult,
      failureStage: 'remoteCreate',
      failureCode: 'remote_repository_name_mismatch'
    })

    expect(isPublishAuthenticationError(authenticationError)).toBe(true)
    expect(isPublishAuthenticationError(nameMismatchError)).toBe(false)
    expect(isPublishAuthenticationError(new Error('authentication'))).toBe(false)
  })
})
