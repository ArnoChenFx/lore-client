import { describe, expect, it } from 'vitest'

import { LoreRepositoryPublishError } from '../../services/lore'
import {
  isRepositoryToolsBusy,
  findConnectedRemoteRepository,
  isPublishAuthenticationError,
  normalizeRepositoryToolPaths,
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

  it('retries publishing only for the stable authentication failure', () => {
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
