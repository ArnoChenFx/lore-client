import { beforeEach, describe, expect, it } from 'bun:test'

import i18n from '../i18n'
import zhCN from '../i18n/locales/zh-CN'
import type { LoreEvent, LoreLinkDetails } from '../types'
import {
  DEFAULT_SERVER_URL,
  isAuthenticationRequiredError,
  LoreCommandClientError,
  parseFileDependencies,
  parseFileLocks,
  parseMetadataEntries,
  parseDiagnosticReport,
  repositoryPublishFailureMessage,
  resolveDefaultServerUrl,
  resolvePatchDestination,
  revisionDiffsToChangeFiles,
  withPatchExtension
} from './lore'
import { parseAuthIdentities } from './lore/auth'
import { parseBranchDiff, parseBranchInfo, parseBranchLatest, parseBranches } from './lore/branches'
import { parseLayers, parseLinkInfo, parseLinks } from './lore/composition'
import { parseRepositoryConfigValue } from './lore/config'
import { serverUrlFromRepositoryUrl } from './lore/core'
import { parseRemoteRepositories } from './lore/remote'
import { parseRepository } from './lore/repositories'
import {
  parseChanges,
  parseFileHistory,
  parseRevisionBisect,
  parseRevisionFind,
  parseRevisionInfo,
  parseRevisions
} from './lore/revisions'
import { parseWorkingTreeDiffs } from './lore/workspace'

const repositoryPath = 'E:\\Worlds\\RealLore'
/** Lore 零哈希的十六进制形态；用于模拟“远端未查询”。 */
const ZERO_HASH = '0'.repeat(64)

describe('Lore event adapter', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US')
  })

  it('resolves the local default server and explicit environment overrides', () => {
    expect(resolveDefaultServerUrl(undefined)).toBe('lore://127.0.0.1:41337')
    expect(resolveDefaultServerUrl('   ')).toBe('lore://127.0.0.1:41337')
    expect(resolveDefaultServerUrl(' lore://192.0.2.1:41337 ')).toBe('lore://192.0.2.1:41337')
    expect(DEFAULT_SERVER_URL).toBeTruthy()
  })

  it('preserves structured authentication errors for recovery control flow', () => {
    const authenticationError = new LoreCommandClientError(
      { code: 'auth_required', message: 'The Lore server requires authentication' },
      'lore_repository_list'
    )
    const unrelatedError = new LoreCommandClientError(
      { code: 'repository_unavailable', message: 'The repository is unavailable' },
      'lore_repository_list'
    )

    expect(authenticationError.code).toBe('auth_required')
    expect(isAuthenticationRequiredError(authenticationError)).toBe(true)
    expect(isAuthenticationRequiredError(unrelatedError)).toBe(false)
    expect(isAuthenticationRequiredError(new Error('authentication'))).toBe(false)
  })

  it('preserves incomplete View recovery details and backup paths in both languages', async () => {
    const upstream = {
      code: 'repository_view_recovery_incomplete',
      message:
        'Apply sync failed. Recovery is incomplete: cache unavailable. The original view backup has been retained at E:\\Worlds\\.lore\\.view.backup.'
    }
    for (const language of ['en-US', 'zh-CN']) {
      await i18n.changeLanguage(language)
      const error = new LoreCommandClientError(upstream, 'lore_repository_view_apply')
      expect(error.code).toBe(upstream.code)
      expect(error.message).toBe(upstream.message)
    }
  })

  it('localizes a linked View while preserving its error code and original detail', async () => {
    const upstream = {
      code: 'repository_view_is_link',
      message: 'Cannot apply view rules because E:\\Worlds\\.lore\\view is a symbolic link; use a regular view file'
    }
    for (const [language, message] of [
      ['en-US', 'The View is a symbolic link. Use a regular rules file and try again.'],
      ['zh-CN', zhCN.repositoryViewIsLink]
    ]) {
      await i18n.changeLanguage(language)
      const error = new LoreCommandClientError(upstream, 'lore_repository_view_apply')
      expect(error.code).toBe(upstream.code)
      expect(error.message).toBe(`${message}\n${upstream.message}`)
      const withoutDetail = new LoreCommandClientError({ code: upstream.code }, 'lore_repository_view_apply')
      expect(withoutDetail.message).toBe(message)
    }
  })

  it('localizes an existing patch destination while keeping the stable error code', async () => {
    const upstream = { code: 'patch_destination_exists', message: 'A file already exists at E:\\Patches\\World.patch' }

    const englishError = new LoreCommandClientError(upstream, 'lore_write_patch_file')
    expect(englishError.code).toBe('patch_destination_exists')
    expect(englishError.message).toBe(
      'A file with that name already exists here. Choose another name to save the patch; the existing file was not replaced.'
    )

    await i18n.changeLanguage('zh-CN')
    const chineseError = new LoreCommandClientError(upstream, 'lore_write_patch_file')
    expect(chineseError.code).toBe('patch_destination_exists')
    expect(chineseError.message).toBe(zhCN.patchDestinationExists)
    expect(chineseError.message).not.toContain('E:\\Patches')
  })

  it('localizes a patch destination that is a symbolic link while keeping the stable error code', async () => {
    const upstream = {
      code: 'patch_destination_is_link',
      message: 'E:\\Patches\\World.patch is a symbolic link; choose another name to save the patch'
    }

    const englishError = new LoreCommandClientError(upstream, 'lore_write_patch_file')
    expect(englishError.code).toBe('patch_destination_is_link')
    expect(englishError.message).toBe(
      'That location is a symbolic link. Choose another name to save the patch; the file the link points to is unchanged.'
    )

    await i18n.changeLanguage('zh-CN')
    const chineseError = new LoreCommandClientError(upstream, 'lore_write_patch_file')
    expect(chineseError.code).toBe('patch_destination_is_link')
    expect(chineseError.message).toBe(zhCN.patchDestinationIsLink)
    expect(chineseError.message).not.toContain('E:\\Patches')
    await i18n.changeLanguage('en-US')
  })

  it('converts a complete revision diff into stable files and line statistics', () => {
    expect(
      revisionDiffsToChangeFiles([
        {
          path: 'Content/Config/World.ini',
          action: 'modify',
          patch: [
            '--- a/Content/Config/World.ini',
            '+++ b/Content/Config/World.ini',
            '@@ -1 +1 @@',
            '-Budget=768',
            '+Budget=896'
          ].join('\n')
        },
        {
          path: 'Content/Legacy.uasset',
          action: 'delete',
          patch: 'Binary files differ\n'
        },
        {
          path: 'Scripts/World.gd',
          action: 'add',
          patch: '--- /dev/null\n+++ Scripts/World.gd\n@@ -0,0 +1 @@\n+extends Node'
        }
      ])
    ).toMatchObject([
      {
        name: 'World.ini',
        path: 'Content/Config',
        status: 'modified',
        additions: 1,
        deletions: 1,
        binary: false
      },
      {
        name: 'Legacy.uasset',
        path: 'Content',
        status: 'deleted',
        additions: 0,
        deletions: 0,
        binary: true
      },
      {
        name: 'World.gd',
        path: 'Scripts',
        status: 'added',
        additions: 1,
        deletions: 0,
        binary: false
      }
    ])
  })

  it('creates repository and file DTOs from real status events', () => {
    const events: LoreEvent[] = [
      {
        tagName: 'repositoryStatusRevision',
        data: {
          repository: 'repository-id',
          branchName: 'main',
          revisionLocalNumber: 8,
          revisionRemoteNumber: 6,
          isLocalAhead: 1,
          isRemoteAhead: 0,
          remoteAvailable: 1,
          remoteAuthorized: 1
        }
      },
      {
        tagName: 'repositoryStatusFile',
        data: {
          path: 'Content/Maps/World.umap',
          size: 4096,
          action: 'keep',
          type: 'file',
          flagStaged: true,
          contentClassification: { kind: 'unknown', source: 'deferred' }
        }
      }
    ]

    const repository = parseRepository(repositoryPath, events)
    const changes = parseChanges(events)

    expect(repository).toMatchObject({
      id: 'repository-id',
      name: 'RealLore',
      branch: 'main',
      ahead: 2,
      behind: 0,
      online: true,
      remoteState: 'online'
    })
    expect(changes).toEqual([
      expect.objectContaining({
        path: 'Content/Maps',
        name: 'World.umap',
        status: 'modified',
        staged: true,
        size: '4.0 KB',
        contentClassification: { kind: 'unknown', source: 'deferred' },
        binary: false
      })
    ])
  })

  it('distinguishes local, offline and unauthorized repository states', () => {
    const statusEvent = (remoteAvailable: boolean, remoteAuthorized: boolean): LoreEvent[] => [
      {
        tagName: 'repositoryStatusRevision',
        data: { remoteAvailable, remoteAuthorized }
      }
    ]

    expect(parseRepository(repositoryPath, statusEvent(false, false)).remoteState).toBe('local')
    expect(
      parseRepository(repositoryPath, statusEvent(false, false), {
        remoteUrl: 'lore://example.com/repository'
      }).remoteState
    ).toBe('offline')
    expect(
      parseRepository(repositoryPath, statusEvent(true, false), {
        remoteUrl: 'lore://example.com/repository'
      }).remoteState
    ).toBe('unauthorized')
  })

  it('does not infer branch synchronization without explicit status evidence', () => {
    const branchEvents: LoreEvent[] = [
      {
        tagName: 'branchListEntry',
        data: { id: 'main-id', name: 'main', latest: 'main-tip', location: 'local', isCurrent: true }
      },
      {
        tagName: 'branchListEntry',
        data: { id: 'feature-id', name: 'feature/a', latest: 'feature-tip', location: 'local' }
      },
      {
        tagName: 'branchListEntry',
        data: { id: 'main-id', name: 'main', latest: 'remote-tip', location: 'remote' }
      }
    ]
    const repositoryWithoutEvidence = parseRepository(
      repositoryPath,
      [
        {
          tagName: 'repositoryStatusRevision',
          data: {
            branchName: 'main',
            remoteAvailable: true,
            remoteAuthorized: true
          }
        }
      ],
      { remoteUrl: 'lore://example.com' }
    )

    expect(repositoryWithoutEvidence.currentBranchSyncState).toBe('unknown')
    expect(parseBranches(branchEvents, repositoryWithoutEvidence)).toEqual([
      expect.objectContaining({ name: 'main', syncState: 'unknown', current: true }),
      expect.objectContaining({ name: 'feature/a', syncState: 'local-only' }),
      expect.objectContaining({ name: 'main', syncState: 'remote', remote: true })
    ])

    const repositoryWithNullMarkers = parseRepository(
      repositoryPath,
      [
        {
          tagName: 'repositoryStatusRevision',
          data: {
            branchName: 'main',
            isLocalAhead: null,
            isRemoteAhead: null,
            remoteAvailable: true,
            remoteAuthorized: true
          }
        }
      ],
      { remoteUrl: 'lore://example.com' }
    )
    expect(repositoryWithNullMarkers.currentBranchSyncState).toBe('unknown')
  })

  it('normalizes unknown branch creator sentinels while preserving real creators', () => {
    const repository = parseRepository(repositoryPath, [])
    const branches = parseBranches(
      [
        {
          tagName: 'branchListEntry',
          data: { id: 'angle-id', name: 'angle', location: 'local', creator: '<unknown>' }
        },
        {
          tagName: 'branchListEntry',
          data: { id: 'plain-id', name: 'plain', location: 'local', creator: ' UNKNOWN ' }
        },
        {
          tagName: 'branchListEntry',
          data: { id: 'known-id', name: 'known', location: 'local', creator: ' Arno Chen ' }
        }
      ],
      repository
    )

    expect(branches.find((branch) => branch.name === 'angle')?.author).toBeUndefined()
    expect(branches.find((branch) => branch.name === 'plain')?.author).toBeUndefined()
    expect(branches.find((branch) => branch.name === 'known')?.author).toBe('Arno Chen')
  })

  it('uses exact branch IDs to distinguish local-only synced and different pointers', () => {
    const repository = parseRepository(
      repositoryPath,
      [
        {
          tagName: 'repositoryStatusRevision',
          data: {
            branchName: 'main',
            remoteAvailable: true,
            remoteAuthorized: true
          }
        }
      ],
      { remoteUrl: 'lore://example.com' }
    )
    const branches = parseBranches(
      [
        {
          tagName: 'branchListEntry',
          data: { id: 'local-id', name: 'feature/local', latest: 'local-tip', location: 'local' }
        },
        {
          tagName: 'branchListEntry',
          data: { id: 'synced-id', name: 'feature/synced', latest: 'same-tip', location: 'local' }
        },
        {
          tagName: 'branchListEntry',
          data: { id: 'different-id', name: 'feature/different', latest: 'local-new', location: 'local' }
        },
        {
          tagName: 'branchListBegin',
          data: { location: 'remote' }
        },
        {
          tagName: 'branchListEntry',
          data: { id: 'synced-id', name: 'feature/synced', latest: 'same-tip', location: 'remote' }
        },
        {
          tagName: 'branchListEntry',
          data: { id: 'different-id', name: 'feature/different', latest: 'remote-old', location: 'remote' }
        },
        {
          tagName: 'branchListEnd',
          data: { location: 'remote', count: 2 }
        }
      ],
      repository
    )

    expect(branches.find((branch) => branch.id === 'local:local-id')?.syncState).toBe('local-only')
    expect(branches.find((branch) => branch.id === 'local:synced-id')?.syncState).toBe('synced')
    expect(branches.find((branch) => branch.id === 'local:different-id')?.syncState).toBe('unknown')
  })

  it('projects explicit current branch status without applying it to other branches', () => {
    const repository = parseRepository(
      repositoryPath,
      [
        {
          tagName: 'repositoryStatusRevision',
          data: {
            branchName: 'main',
            revisionLocalNumber: 8,
            revisionRemoteNumber: 6,
            isLocalAhead: true,
            isRemoteAhead: false,
            remoteAvailable: true,
            remoteAuthorized: true
          }
        }
      ],
      { remoteUrl: 'lore://example.com' }
    )
    const branches = parseBranches(
      [
        {
          tagName: 'branchListEntry',
          data: { id: 'main-id', name: 'main', latest: 'main-tip', location: 'local', isCurrent: true }
        },
        {
          tagName: 'branchListEntry',
          data: { id: 'feature-id', name: 'feature/a', latest: 'feature-tip', location: 'local' }
        }
      ],
      repository
    )

    expect(repository.currentBranchSyncState).toBe('ahead')
    expect(branches[0]).toMatchObject({ name: 'main', syncState: 'ahead', ahead: 2, behind: 0 })
    expect(branches[1]).toMatchObject({ name: 'feature/a', syncState: 'unknown' })
  })

  it('distinguishes synced unavailable and local-only branch evidence', () => {
    const status = (remoteAvailable: boolean, remoteAuthorized: boolean): LoreEvent[] => [
      {
        tagName: 'repositoryStatusRevision',
        data: {
          branchName: 'main',
          isLocalAhead: false,
          isRemoteAhead: false,
          remoteAvailable,
          remoteAuthorized
        }
      }
    ]
    const currentBranch: LoreEvent[] = [
      {
        tagName: 'branchListEntry',
        data: { id: 'main-id', name: 'main', latest: 'main-tip', location: 'local', isCurrent: true }
      }
    ]
    const onlineRepository = parseRepository(repositoryPath, status(true, true), {
      remoteUrl: 'lore://example.com'
    })
    const offlineRepository = parseRepository(repositoryPath, status(false, false), {
      remoteUrl: 'lore://example.com'
    })
    const localRepository = parseRepository(repositoryPath, status(false, false))

    expect(parseBranches(currentBranch, onlineRepository)[0]?.syncState).toBe('synced')
    expect(parseBranches(currentBranch, offlineRepository)[0]?.syncState).toBe('unavailable')
    expect(parseBranches(currentBranch, localRepository)[0]?.syncState).toBe('local-only')
  })

  it('maps query and status events to one stable collaborative lock DTO', () => {
    const events: LoreEvent[] = [
      {
        tagName: 'lockFileQuery',
        data: {
          path: 'Content/Characters/Hero.uasset',
          owner: 'artist@example.com',
          lockedAt: 1_753_430_400_000
        }
      },
      {
        tagName: 'lockFileStatus',
        data: {
          path: 'Source/Game.ts',
          branch: 'feature/gameplay',
          owner: 'developer@example.com',
          lockedAt: 1_753_430_500_000
        }
      },
      {
        tagName: 'lockFileQuery',
        data: { path: '', owner: 'invalid' }
      }
    ]

    expect(parseFileLocks(events, 'main', 'lockFileQuery')).toEqual([
      {
        path: 'Content/Characters/Hero.uasset',
        branch: 'main',
        owner: 'artist@example.com',
        lockedAt: 1_753_430_400_000
      }
    ])
    expect(parseFileLocks(events, 'main', 'lockFileStatus')).toEqual([
      {
        path: 'Source/Game.ts',
        branch: 'feature/gameplay',
        owner: 'developer@example.com',
        lockedAt: 1_753_430_500_000
      }
    ])
  })

  it('groups dependency list entries by root file and preserves tags and depth', () => {
    const events: LoreEvent[] = [
      {
        tagName: 'fileDependencyListFile',
        data: { path: 'Content/Maps/World.umap', entryCount: 2 }
      },
      {
        tagName: 'fileDependencyListEntry',
        data: { path: 'Content/Materials/World.mat', tags: ['runtime'], depth: 1 }
      },
      {
        tagName: 'fileDependencyListEntry',
        data: { path: 'Content/Textures/World.tga', tags: ['runtime', 'high-resolution'], depth: 2 }
      },
      {
        tagName: 'fileDependencyListFileEnd',
        data: { path: 'Content/Maps/World.umap' }
      }
    ]

    expect(parseFileDependencies(events, false, true, 4)).toEqual({
      groups: [
        {
          path: 'Content/Maps/World.umap',
          entries: [
            { path: 'Content/Materials/World.mat', tags: ['runtime'], depth: 1 },
            { path: 'Content/Textures/World.tga', tags: ['runtime', 'high-resolution'], depth: 2 }
          ]
        }
      ],
      reverse: false,
      recursive: true,
      depthLimit: 4
    })
  })

  it('keeps a newly added empty file in the change list', () => {
    const changes = parseChanges([
      {
        tagName: 'repositoryStatusFile',
        data: {
          path: 'Content/Empty.txt',
          size: 0,
          action: 'add',
          type: 'file',
          flagStaged: false
        }
      }
    ])

    expect(changes).toEqual([
      expect.objectContaining({
        path: 'Content',
        name: 'Empty.txt',
        status: 'added',
        staged: false,
        size: '0 B'
      })
    ])
  })

  it('associates metadata following a history entry with the matching revision', () => {
    const repository = parseRepository(repositoryPath, [
      {
        tagName: 'repositoryStatusRevision',
        data: { repository: 'repository-id', branchName: 'main', revision: 'abcdef1234567890' }
      }
    ])
    const events: LoreEvent[] = [
      {
        tagName: 'revisionHistoryEntry',
        data: {
          revision: 'abcdef1234567890',
          revisionNumber: 12,
          parent: ['1234567890abcdef', '0000000000000000']
        }
      },
      {
        tagName: 'metadata',
        data: {
          key: 'message',
          value: { tagName: 'string', data: 'Integrate real Lore history' }
        }
      },
      {
        tagName: 'metadata',
        data: {
          key: 'committed-by',
          value: { tagName: 'string', data: 'Arno' }
        }
      }
    ]

    expect(parseRevisions(events, repository)).toEqual([
      expect.objectContaining({
        id: 'abcdef1234567890',
        shortId: 'abcdef12',
        title: 'Integrate real Lore history',
        author: 'Arno',
        parentCount: 1,
        parentIds: ['1234567890abcdef'],
        branchPointers: [{ id: 'head', name: 'HEAD', kind: 'head' }]
      })
    ])
  })

  it.each([undefined, null, '', '  ', ' revision-id ', 12, ZERO_HASH])(
    'rejects invalid history identities instead of inventing an actionable revision ID: %p',
    (revision) => {
      const repository = parseRepository(repositoryPath, [])
      expect(() => parseRevisions([{ tagName: 'revisionHistoryEntry', data: { revision } }], repository)).toThrow(
        expect.objectContaining({
          code: 'revision_history_invalid_identity',
          command: 'lore_revision_history'
        })
      )
    }
  )

  it('keeps raw history facts independent of the language used while loading', async () => {
    const repository = parseRepository(repositoryPath, [])
    const events: LoreEvent[] = [
      { tagName: 'revisionHistoryEntry', data: { revision: 'opaque-revision-id', revisionNumber: 12 } },
      { tagName: 'metadata', data: { key: 'timestamp', value: { tagName: 'numeric', data: 1_753_392_600 } } }
    ]
    const english = parseRevisions(events, repository)
    await i18n.changeLanguage('zh-CN')
    const chinese = parseRevisions(events, repository)

    expect(chinese).toEqual(english)
    expect(english[0]).toMatchObject({
      id: 'opaque-revision-id',
      revisionNumber: 12,
      committedAt: 1_753_392_600_000,
      title: '',
      author: ''
    })
  })

  it('attaches every active branch pointer to its exact latest revision', () => {
    const repository = parseRepository(repositoryPath, [
      {
        tagName: 'repositoryStatusRevision',
        // 工作区停在 base，但 main 指针仍在 merge-tip；两类标记必须分别附着。
        data: { repository: 'repository-id', branchName: 'main', revision: 'base' }
      }
    ])
    const branches = parseBranches(
      [
        {
          tagName: 'branchListEntry',
          data: { id: 'main-id', name: 'main', latest: 'merge-tip', location: 'local', isCurrent: true }
        },
        {
          tagName: 'branchListEntry',
          data: { id: 'vv-id', name: 'vv', latest: 'vv-tip', location: 'local' }
        },
        {
          tagName: 'branchListEntry',
          data: { id: 'published-id', name: 'vv', latest: 'vv-tip', location: 'remote' }
        },
        {
          tagName: 'branchListEntry',
          data: { id: 'archived-id', name: 'old-vv', latest: 'vv-tip', location: 'local', archived: true }
        }
      ],
      repository
    )

    const revisions = parseRevisions(
      [
        {
          tagName: 'revisionHistoryEntry',
          data: { revision: 'merge-tip', revisionNumber: 3, parent: ['vv-tip', 'base'] }
        },
        {
          tagName: 'revisionHistoryEntry',
          data: { revision: 'vv-tip', revisionNumber: 2, parent: ['base'] }
        },
        {
          tagName: 'revisionHistoryEntry',
          data: { revision: 'base', revisionNumber: 1, parent: [] }
        }
      ],
      repository,
      branches
    )

    expect(revisions[0]?.branchPointers).toEqual([{ id: 'local:main-id', name: 'main', kind: 'local' }])
    expect(revisions[1]?.branchPointers).toEqual([
      { id: 'local:vv-id', name: 'vv', kind: 'local' },
      { id: 'remote:published-id', name: 'vv', kind: 'remote' }
    ])
    expect(revisions[2]?.branchPointers).toEqual([{ id: 'head', name: 'HEAD', kind: 'head' }])
  })

  it('normalizes branch collaboration info, protection, LATEST history, and diff events', () => {
    expect(
      parseBranchInfo(
        [
          {
            tagName: 'branchInfo',
            data: {
              id: 'branch-id',
              name: 'main',
              category: 'production',
              latest: 'latest-3',
              latestRemote: 'latest-2',
              parent: 'parent-id',
              branchPoint: 'root-1',
              creator: 'user-id',
              created: 42,
              archived: false
            }
          }
        ],
        [
          {
            tagName: 'metadata',
            data: { key: 'protect', value: { tagName: 'boolean', data: true } }
          }
        ]
      )
    ).toEqual({
      id: 'branch-id',
      name: 'main',
      category: 'production',
      latest: 'latest-3',
      latestRemote: 'latest-2',
      parent: 'parent-id',
      branchPoint: 'root-1',
      creator: 'user-id',
      created: 42,
      archived: false,
      protected: true
    })

    expect(
      parseBranchLatest([
        { tagName: 'branchLatestListEntry', data: { branch: 'branch-id', revision: 'latest-3' } },
        { tagName: 'branchLatestListEntry', data: { branch: 'branch-id', revision: 'latest-2' } }
      ])
    ).toEqual([
      { branch: 'branch-id', revision: 'latest-3' },
      { branch: 'branch-id', revision: 'latest-2' }
    ])

    expect(
      parseBranchDiff(
        [
          {
            tagName: 'branchDiffChange',
            data: { change: { path: 'Source/App.tsx', action: 'modify', automerged: true } }
          },
          {
            tagName: 'branchDiffConflict',
            data: {
              sourceChange: { path: 'Content/Hero.uasset', action: 'modify', automerged: false },
              targetChange: { path: 'Content/Hero.uasset', action: 'delete', automerged: false }
            }
          }
        ],
        'feature',
        'main'
      )
    ).toEqual({
      source: 'feature',
      target: 'main',
      changes: [{ path: 'Source/App.tsx', action: 'modify', automerged: true }],
      conflicts: [
        {
          path: 'Content/Hero.uasset',
          source: { path: 'Content/Hero.uasset', action: 'modify', automerged: false },
          target: { path: 'Content/Hero.uasset', action: 'delete', automerged: false }
        }
      ]
    })
  })

  it('normalizes Revision Info, Find, and Bisect events without leaking Lore event shapes', () => {
    expect(
      parseRevisionInfo([
        {
          tagName: 'revisionInfo',
          data: {
            repository: 'repository-id',
            revision: 'revision-42',
            revisionNumber: 42,
            parent: ['revision-41', '0000000000000000']
          }
        },
        {
          tagName: 'revisionInfoDelta',
          data: {
            path: 'Source/App.tsx',
            fromPath: 'Source/Main.tsx',
            size: 512,
            action: 'modify',
            flagModify: true,
            flagMerged: false,
            flagFile: true
          }
        },
        {
          tagName: 'revisionInfoDelta',
          data: {
            path: 'Source/Added.tsx',
            size: 128,
            action: 'add',
            flagModify: false,
            flagMerged: false,
            flagFile: true
          }
        },
        {
          tagName: 'metadata',
          data: { key: 'message', value: { tagName: 'string', data: 'Fix startup' } }
        }
      ])
    ).toEqual({
      repository: 'repository-id',
      revision: 'revision-42',
      revisionNumber: 42,
      parentIds: ['revision-41'],
      deltas: [
        {
          path: 'Source/App.tsx',
          fromPath: 'Source/Main.tsx',
          size: 512,
          action: 'modify',
          modified: true,
          merged: false,
          file: true
        },
        {
          // 新增文件没有来源路径：不得用 path 回填。
          path: 'Source/Added.tsx',
          fromPath: '',
          size: 128,
          action: 'add',
          modified: false,
          merged: false,
          file: true
        }
      ],
      metadata: { message: 'Fix startup' }
    })
    expect(parseRevisionFind([{ tagName: 'revisionFind', data: { signature: 'found-revision' } }])).toBe(
      'found-revision'
    )
    expect(
      parseRevisionBisect([
        {
          tagName: 'revisionBisect',
          data: { startRevisionNumber: 10, targetRevisionNumber: 20, endRevisionNumber: 30, done: false }
        }
      ])
    ).toEqual({
      startRevisionNumber: 10,
      targetRevisionNumber: 20,
      endRevisionNumber: 30,
      done: false
    })
  })

  it('projects stored authentication identities without exposing cached tokens', () => {
    expect(
      parseAuthIdentities([
        {
          tagName: 'authIdentity',
          data: {
            authUrl: 'ucs-auth://auth.example.com',
            resource: '',
            userId: 'user-1',
            authorizedDomains: 'example.com, assets.example.com',
            expires: 1_800_000_000_000,
            token: 'must-never-appear'
          }
        }
      ])
    ).toEqual([
      {
        authUrl: 'ucs-auth://auth.example.com',
        resource: '',
        userId: 'user-1',
        authorizedDomains: ['example.com', 'assets.example.com'],
        expiresAt: 1_800_000_000_000,
        displayName: undefined
      }
    ])
    expect(JSON.stringify(parseAuthIdentities([]))).not.toContain('token')
  })

  it('preserves Lore Branch stack points for Revision checkout ownership', () => {
    const repository = parseRepository(repositoryPath, [
      {
        tagName: 'repositoryStatusRevision',
        data: { repository: 'repository-id', branchName: 'main', revision: 'merge-tip' }
      }
    ])

    const parsed = parseBranches(
      [
        {
          tagName: 'branchListEntry',
          data: {
            id: 'vv-id',
            name: 'vv',
            latest: 'vv-tip',
            location: 'local',
            stack: [{ branch: 'main-id', revision: 'branch-point' }]
          }
        }
      ],
      repository
    )

    expect(parsed.find((branch) => branch.name === 'vv')?.branchPoints).toEqual([
      { branch: 'main-id', revision: 'branch-point' }
    ])
  })

  it('splits a Git-style history identity into display name and avatar email', () => {
    const repository = parseRepository(repositoryPath, [
      {
        tagName: 'repositoryStatusRevision',
        data: { repository: 'repository-id', branchName: 'main' }
      }
    ])
    const revisions = parseRevisions(
      [
        {
          tagName: 'revisionHistoryEntry',
          data: { revision: 'abcdef1234567890', revisionNumber: 13, parent: [] }
        },
        {
          tagName: 'metadata',
          data: {
            key: 'committed-by',
            value: { tagName: 'string', data: 'Arno Chen <arno@example.com>' }
          }
        }
      ],
      repository
    )

    expect(revisions[0]).toMatchObject({
      author: 'Arno Chen',
      authorEmail: 'arno@example.com',
      initials: 'A'
    })
  })

  it('preserves an Auth user ID for background name resolution', () => {
    const repository = parseRepository(repositoryPath, [
      {
        tagName: 'repositoryStatusRevision',
        data: { repository: 'repository-id', branchName: 'main' }
      }
    ])
    const revisions = parseRevisions(
      [
        {
          tagName: 'revisionHistoryEntry',
          data: { revision: 'abcdef1234567890', revisionNumber: 13, parent: [] }
        },
        {
          tagName: 'metadata',
          data: {
            key: 'committed-by',
            value: { tagName: 'string', data: 'user-42' }
          }
        }
      ],
      repository
    )

    expect(revisions[0]).toMatchObject({
      authorIdentity: 'user-42',
      author: 'user-42',
      authorEmail: undefined,
      initials: 'U'
    })
  })

  it('does not scale Lore millisecond timestamps as seconds', () => {
    const repository = parseRepository(repositoryPath, [
      {
        tagName: 'repositoryStatusRevision',
        data: { repository: 'repository-id', branchName: 'main' }
      }
    ])
    const revisions = parseRevisions(
      [
        {
          tagName: 'revisionHistoryEntry',
          data: {
            revision: 'abcdef1234567890',
            revisionNumber: 12,
            parent: []
          }
        },
        {
          tagName: 'metadata',
          data: {
            key: 'timestamp',
            value: { tagName: 'numeric', data: 1_753_392_600_000 }
          }
        }
      ],
      repository
    )

    expect(revisions[0]?.committedAt).toBe(1_753_392_600_000)
  })

  it('preserves a missing historical author instead of using the current identity or a translated label', () => {
    const repository = {
      ...parseRepository(repositoryPath, [
        {
          tagName: 'repositoryStatusRevision',
          data: { repository: 'repository-id', branchName: 'main' }
        }
      ]),
      identity: 'Arno'
    }

    expect(
      parseRevisions(
        [
          {
            tagName: 'revisionHistoryEntry',
            data: {
              revision: 'abcdef1234567890',
              revisionNumber: 12,
              parent: []
            }
          }
        ],
        repository
      )[0]?.author
    ).toBe('')
  })

  it('removes the Windows extended path prefix from displayed repository paths', () => {
    expect(
      parseRepository('\\\\?\\E:\\Game\\godot\\projects\\godot-multi-player', [
        {
          tagName: 'repositoryStatusRevision',
          data: { repository: 'repository-id', branchName: 'main' }
        }
      ]).path
    ).toBe('E:\\Game\\godot\\projects\\godot-multi-player')
  })

  it('preserves unresolved conflict counts from status events', () => {
    const events: LoreEvent[] = [
      {
        tagName: 'repositoryStatusRevision',
        data: { repository: 'repository-id', branchName: 'main' }
      },
      {
        tagName: 'repositoryStatusFile',
        data: {
          path: 'Content/Conflict.txt',
          type: 'file',
          flagConflict: true,
          flagConflictUnresolved: true
        }
      }
    ]
    const repository = parseRepository(repositoryPath, events)
    const changes = parseChanges(events)

    expect(repository).toMatchObject({
      conflictCount: 1,
      unresolvedConflictCount: 1
    })
    expect(changes[0]).toMatchObject({
      conflict: true,
      conflictUnresolved: true
    })
  })

  it('normalizes a repository remote URL to its server root', () => {
    const events: LoreEvent[] = [
      {
        tagName: 'repositoryConfigGet',
        data: {
          key: 'remote_url',
          value: 'lore://192.168.11.20:41337/world'
        }
      }
    ]

    const remoteUrl = parseRepositoryConfigValue(events, 'remote_url')
    expect(remoteUrl).toBe('lore://192.168.11.20:41337/world')
    expect(serverUrlFromRepositoryUrl(remoteUrl)).toBe('lore://192.168.11.20:41337')
  })

  it('creates the remote repository directory from server list events', () => {
    const events: LoreEvent[] = [
      {
        tagName: 'repositoryListEntry',
        data: { id: '7fcda7b9', name: 'world-building' }
      },
      { tagName: 'complete', data: { status: 0 } }
    ]

    expect(parseRemoteRepositories(events)).toEqual([{ id: '7fcda7b9', name: 'world-building' }])
  })

  it('sorts remote repositories by name and identifier for a stable directory order', () => {
    const events: LoreEvent[] = [
      { tagName: 'repositoryListEntry', data: { id: 'id-zulu', name: 'Zulu' } },
      { tagName: 'repositoryListEntry', data: { id: 'id-alpha-2', name: 'alpha' } },
      { tagName: 'repositoryListEntry', data: { id: 'id-alpha-1', name: 'Alpha' } }
    ]

    expect(parseRemoteRepositories(events)).toEqual([
      { id: 'id-alpha-1', name: 'Alpha' },
      { id: 'id-alpha-2', name: 'alpha' },
      { id: 'id-zulu', name: 'Zulu' }
    ])
  })

  it('preserves archived state from Lore branch list events', () => {
    const repository = parseRepository(repositoryPath, [
      {
        tagName: 'repositoryStatusRevision',
        data: { repository: 'repository-id', branchName: 'main' }
      }
    ])

    expect(
      parseBranches(
        [
          {
            tagName: 'branchListEntry',
            data: {
              id: 'feature-archive-id',
              name: 'feature/archive-me',
              location: 'local',
              latest: 'abcdef1234567890',
              archived: true
            }
          }
        ],
        repository
      )
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'local:feature-archive-id',
          name: 'feature/archive-me',
          archived: true
        }),
        expect.objectContaining({
          id: 'local:main',
          name: 'main',
          current: true
        })
      ])
    )
  })

  it('creates repository resources from Lore layer and link events', () => {
    const events: LoreEvent[] = [
      {
        tagName: 'layerEntry',
        data: {
          targetPath: 'Content/Shared',
          sourceRepository: 'repository-shared',
          sourcePath: 'Assets',
          metadata: 'release',
          revision: 'layer-revision'
        }
      },
      {
        tagName: 'linkEntry',
        data: {
          link: 'repository-tools',
          linkPath: 'Tools',
          sourcePath: 'Editor',
          branchName: 'main',
          revision: 'link-revision',
          flags: 1
        }
      }
    ]
    const stagedEvents: LoreEvent[] = [
      {
        tagName: 'layerStagedEntry',
        data: {
          targetPath: 'Content/Shared',
          sourceRepository: 'repository-shared',
          stagedFileCount: 3
        }
      },
      {
        tagName: 'linkStagedEntry',
        data: {
          path: 'Tools',
          repository: 'repository-tools',
          stagedFileCount: 5
        }
      }
    ]

    expect(parseLayers(events, stagedEvents)).toEqual([
      expect.objectContaining({
        id: 'repository-shared:Content/Shared',
        targetPath: 'Content/Shared',
        sourceRepository: 'repository-shared',
        stagedFileCount: 3
      })
    ])
    expect(parseLinks(events, stagedEvents)).toEqual([
      expect.objectContaining({
        id: 'repository-tools:Tools',
        linkPath: 'Tools',
        repository: 'repository-tools',
        branchName: 'main',
        disableAutoFollow: true,
        stagedFileCount: 5
      })
    ])
  })

  it('parses link info details and clears the remote latest when the hash is zero', () => {
    const events: LoreEvent[] = [
      {
        tagName: 'linkInfo',
        data: {
          entry: {
            link: 'repository-tools',
            linkPath: 'Tools',
            sourcePath: 'Editor',
            branchName: 'main',
            tracking: true,
            revision: 'link-revision',
            flags: 0
          },
          remoteRevision: ZERO_HASH,
          stagedState: 'modified',
          stagedFileCount: 7
        }
      }
    ]

    expect(parseLinkInfo(events)).toEqual({
      linkPath: 'Tools',
      repository: 'repository-tools',
      sourcePath: 'Editor',
      branchName: 'main',
      tracking: true,
      revision: 'link-revision',
      remoteRevision: '',
      stagedState: 'modified',
      stagedFileCount: 7,
      disableAutoFollow: false
    } satisfies LoreLinkDetails)
  })

  it('keeps a real remote latest and rejects unknown staged states', () => {
    const events: LoreEvent[] = [
      {
        tagName: 'linkInfo',
        data: {
          entry: {
            link: 'repository-tools',
            linkPath: 'Tools',
            sourcePath: 'Editor',
            branch: 'main',
            tracking: false,
            revision: 'link-pin-revision',
            flags: 1
          },
          remoteRevision: 'remote-latest-hash',
          stagedState: 'future-enum-value',
          stagedFileCount: 2
        }
      }
    ]

    const details = parseLinkInfo(events)
    expect(details?.remoteRevision).toBe('remote-latest-hash')
    expect(details?.stagedState).toBeNull()
    expect(details?.disableAutoFollow).toBe(true)
  })

  it('returns null when the link info event is missing', () => {
    expect(parseLinkInfo([{ tagName: 'complete', data: { status: 0 } }])).toBeNull()
  })

  it('preserves irreversible remote publication stages and provides safe retry guidance', () => {
    const createResult = {
      status: 0,
      operation: 'repository.create.remote',
      // 事件信封的稳定 DTO 始终包含耗时；测试夹具也必须满足完整类型契约。
      durationMs: 0,
      events: []
    }

    expect(
      repositoryPublishFailureMessage({
        repositoryUrl: 'lore://127.0.0.1:41337/world',
        remoteCreated: true,
        remotePreexisting: false,
        requestedRemoteName: 'world',
        configurationUpdated: false,
        pushed: false,
        createResult,
        failureStage: 'configuration',
        failureMessage: 'The configuration file is read-only'
      })
    ).toBe(
      'Remote repository created, but saving the local remote configuration failed: The configuration file is read-only'
    )

    expect(
      repositoryPublishFailureMessage({
        repositoryUrl: 'lore://127.0.0.1:41337/world',
        remoteCreated: true,
        remotePreexisting: false,
        requestedRemoteName: 'world',
        configurationUpdated: true,
        pushed: false,
        createResult,
        failureStage: 'push',
        failureMessage: 'The server rejected the branch'
      })
    ).toContain('After fixing, you can retry Push directly')

    expect(
      repositoryPublishFailureMessage({
        repositoryUrl: 'lore://127.0.0.1:41337/world',
        remoteCreated: false,
        remotePreexisting: true,
        existingRemoteName: 'world',
        requestedRemoteName: 'world-renamed',
        configurationUpdated: false,
        pushed: false,
        createResult,
        failureStage: 'remoteCreate',
        failureCode: 'remote_repository_name_mismatch'
      })
    ).toContain('already exists on the server as “world”')
  })

  it('creates a real workspace patch from fileDiff events', () => {
    const events: LoreEvent[] = [
      {
        tagName: 'fileDiff',
        data: {
          path: 'Source/App.tsx',
          action: 'keep',
          patch: "@@ -1,2 +1,2 @@\n-const mode = 'dark';\n+const mode = 'light';"
        }
      },
      {
        // 缺少路径的异常事件不会污染右侧 Diff。
        tagName: 'fileDiff',
        data: { path: '', action: 'add', patch: '+invalid' }
      }
    ]

    expect(parseWorkingTreeDiffs(events)).toEqual([
      {
        path: 'Source/App.tsx',
        action: 'keep',
        patch: "@@ -1,2 +1,2 @@\n-const mode = 'dark';\n+const mode = 'light';",
        contentClassification: { kind: 'text', source: 'loreDiff' }
      }
    ])
  })

  it('carries the real move source path from fileDiff events', () => {
    /*
     * `fileDiff` 没有来源路径字段；旧路径只能从上游 `emit_move_diff` 写入的
     * `move from <路径>` 补丁头读出。二进制移动同样带该头部，只是没有正文 hunk。
     */
    const events: LoreEvent[] = [
      {
        tagName: 'fileDiff',
        data: {
          path: 'Content/World/New.uasset',
          action: 'move',
          patch: 'move from Content/World/Old.uasset\nmove to Content/World/New.uasset\nBinary files differ\n'
        }
      },
      {
        // 新增文件没有 `move from` 头，不得凭空得出 previousPath。
        tagName: 'fileDiff',
        data: {
          path: 'Content/World/Added.uasset',
          action: 'add',
          patch: 'diff --git a/Content/World/Added.uasset b/Content/World/Added.uasset\n+payload'
        }
      }
    ]

    expect(parseWorkingTreeDiffs(events)).toEqual([
      {
        path: 'Content/World/New.uasset',
        action: 'move',
        previousPath: 'Content/World/Old.uasset',
        patch: 'move from Content/World/Old.uasset\nmove to Content/World/New.uasset\nBinary files differ\n',
        contentClassification: { kind: 'binary', source: 'loreDiff' }
      },
      {
        path: 'Content/World/Added.uasset',
        action: 'add',
        patch: 'diff --git a/Content/World/Added.uasset b/Content/World/Added.uasset\n+payload',
        contentClassification: { kind: 'text', source: 'loreDiff' }
      }
    ])
  })

  it('creates a file revision timeline from fileHistory events', () => {
    // Lore 0.10.0 起 fileHistory 事件带 `fromPath`：移动/重命名才有值，
    // 其他动作为空字符串。解析必须区分“真实来源路径”与“没有来源路径”。
    const events: LoreEvent[] = [
      {
        tagName: 'fileHistory',
        data: {
          path: 'Content/World.umap',
          fromPath: 'Content/OldWorld.umap',
          revision: 'abcdef1234567890',
          revisionNumber: 42,
          parent: ['1234567890abcdef'],
          size: 8192,
          action: 'move'
        }
      },
      {
        tagName: 'fileHistory',
        data: {
          path: 'Content/World.umap',
          revision: '1234567890abcdef',
          revisionNumber: 41,
          parent: [],
          size: 4096,
          action: 'modify'
        }
      }
    ]

    expect(parseFileHistory(events)).toEqual([
      {
        path: 'Content/World.umap',
        fromPath: 'Content/OldWorld.umap',
        revision: 'abcdef1234567890',
        revisionNumber: 42,
        parent: ['1234567890abcdef'],
        size: 8192,
        action: 'move'
      },
      {
        path: 'Content/World.umap',
        fromPath: '',
        revision: '1234567890abcdef',
        revisionNumber: 41,
        parent: [],
        size: 4096,
        action: 'modify'
      }
    ])
  })

  it('projects typed metadata while hiding raw binary payloads', () => {
    const entries = parseMetadataEntries([
      { tagName: 'metadata', data: { key: 'description', value: { tagName: 'string', data: 'World' } } },
      { tagName: 'metadata', data: { key: 'build', value: { tagName: 'numeric', data: 42 } } },
      { tagName: 'metadata', data: { key: 'blob', value: { tagName: 'binary', data: [1, 2, 3] } } }
    ])

    expect(entries).toEqual([
      { key: 'description', type: 'string', value: 'World' },
      { key: 'build', type: 'numeric', value: '42' },
      { key: 'blob', type: 'binary', value: 'Binary metadata (3 bytes)' }
    ])
  })

  it('reduces diagnostic events to bounded stable findings', () => {
    expect(
      parseDiagnosticReport({
        operation: 'repository.verify',
        status: 0,
        durationMs: 12,
        events: [
          { tagName: 'repositoryVerifyStateBegin', data: {} },
          { tagName: 'error', data: { message: 'corrupt node', path: 'Content/World.umap' } },
          { tagName: 'complete', data: { status: 0 } }
        ]
      })
    ).toMatchObject({
      operation: 'repository.verify',
      durationMs: 12,
      findings: [
        { kind: 'repositoryVerifyStateBegin', error: false },
        { kind: 'error', summary: 'corrupt node', error: true }
      ]
    })
  })
})

describe('patch save path normalization', () => {
  it('keeps .patch and .diff destinations unchanged regardless of case', () => {
    expect(withPatchExtension('/work/Changes.patch')).toBe('/work/Changes.patch')
    expect(withPatchExtension('/work/Changes.DIFF')).toBe('/work/Changes.DIFF')
  })

  it('appends .patch to destinations the native dialog returned without a patch extension', () => {
    expect(withPatchExtension('/work/Changes')).toBe('/work/Changes.patch')
    expect(withPatchExtension('/work/Changes.txt')).toBe('/work/Changes.txt.patch')
  })

  it('lets only a dialog-confirmed path replace an existing file', () => {
    expect(resolvePatchDestination('/work/Changes.patch')).toEqual({
      destinationPath: '/work/Changes.patch',
      replaceExisting: true
    })
    expect(resolvePatchDestination('/work/Changes')).toEqual({
      destinationPath: '/work/Changes.patch',
      replaceExisting: false
    })
  })
})
