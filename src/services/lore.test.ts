import { beforeEach, describe, expect, it } from 'vitest'

import i18n from '../i18n'
import type { LoreEvent } from '../types'
import {
  DEFAULT_SERVER_URL,
  loreEventParsers,
  parseFileDependencies,
  parseFileLocks,
  parseMetadataEntries,
  parseDiagnosticReport,
  repositoryPublishFailureMessage,
  resolveDefaultServerUrl,
  revisionDiffsToChangeFiles
} from './lore'

const repositoryPath = 'E:\\Worlds\\RealLore'

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
          flagStaged: true
        }
      }
    ]

    const repository = loreEventParsers.parseRepository(repositoryPath, events)
    const changes = loreEventParsers.parseChanges(events)

    expect(repository).toMatchObject({
      id: 'repository-id',
      name: 'RealLore',
      branch: 'main',
      ahead: 2,
      behind: 0,
      online: true
    })
    expect(changes).toEqual([
      expect.objectContaining({
        path: 'Content/Maps',
        name: 'World.umap',
        status: 'modified',
        staged: true,
        size: '4.0 KB'
      })
    ])
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
    const changes = loreEventParsers.parseChanges([
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
    const repository = loreEventParsers.parseRepository(repositoryPath, [
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

    expect(loreEventParsers.parseRevisions(events, repository)).toEqual([
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

  it('attaches every active branch pointer to its exact latest revision', () => {
    const repository = loreEventParsers.parseRepository(repositoryPath, [
      {
        tagName: 'repositoryStatusRevision',
        // 工作区停在 base，但 main 指针仍在 merge-tip；两类标记必须分别附着。
        data: { repository: 'repository-id', branchName: 'main', revision: 'base' }
      }
    ])
    const branches = loreEventParsers.parseBranches(
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

    const revisions = loreEventParsers.parseRevisions(
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
      loreEventParsers.parseBranchInfo(
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
      loreEventParsers.parseBranchLatest([
        { tagName: 'branchLatestListEntry', data: { branch: 'branch-id', revision: 'latest-3' } },
        { tagName: 'branchLatestListEntry', data: { branch: 'branch-id', revision: 'latest-2' } }
      ])
    ).toEqual([
      { branch: 'branch-id', revision: 'latest-3' },
      { branch: 'branch-id', revision: 'latest-2' }
    ])

    expect(
      loreEventParsers.parseBranchDiff(
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
      loreEventParsers.parseRevisionInfo([
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
            size: 512,
            action: 'modify',
            flagModify: true,
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
          size: 512,
          action: 'modify',
          modified: true,
          merged: false,
          file: true
        }
      ],
      metadata: { message: 'Fix startup' }
    })
    expect(
      loreEventParsers.parseRevisionFind([{ tagName: 'revisionFind', data: { signature: 'found-revision' } }])
    ).toBe('found-revision')
    expect(
      loreEventParsers.parseRevisionBisect([
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
      loreEventParsers.parseAuthIdentities([
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
    expect(JSON.stringify(loreEventParsers.parseAuthIdentities([]))).not.toContain('token')
  })

  it('preserves Lore Branch stack points for Revision checkout ownership', () => {
    const repository = loreEventParsers.parseRepository(repositoryPath, [
      {
        tagName: 'repositoryStatusRevision',
        data: { repository: 'repository-id', branchName: 'main', revision: 'merge-tip' }
      }
    ])

    const parsed = loreEventParsers.parseBranches(
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
    const repository = loreEventParsers.parseRepository(repositoryPath, [
      {
        tagName: 'repositoryStatusRevision',
        data: { repository: 'repository-id', branchName: 'main' }
      }
    ])
    const revisions = loreEventParsers.parseRevisions(
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

  it('parses an Auth-resolved revision username through the shared identity rules', () => {
    const repository = loreEventParsers.parseRepository(repositoryPath, [
      {
        tagName: 'repositoryStatusRevision',
        data: { repository: 'repository-id', branchName: 'main' }
      }
    ])
    const revisions = loreEventParsers.parseRevisions(
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
      repository,
      [],
      new Map([['user-42', 'Arno Chen <arno@example.com>']])
    )

    expect(revisions[0]).toMatchObject({
      author: 'Arno Chen',
      authorEmail: 'arno@example.com',
      initials: 'A'
    })
  })

  it('does not scale Lore millisecond timestamps as seconds', () => {
    const repository = loreEventParsers.parseRepository(repositoryPath, [
      {
        tagName: 'repositoryStatusRevision',
        data: { repository: 'repository-id', branchName: 'main' }
      }
    ])
    const revisions = loreEventParsers.parseRevisions(
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

    expect(revisions[0]?.timestamp).toMatch(/^2025-/)
  })

  it('keeps an unknown author when history metadata is missing instead of using the current identity', () => {
    const repository = {
      ...loreEventParsers.parseRepository(repositoryPath, [
        {
          tagName: 'repositoryStatusRevision',
          data: { repository: 'repository-id', branchName: 'main' }
        }
      ]),
      identity: 'Arno'
    }

    expect(
      loreEventParsers.parseRevisions(
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
    ).toBe('Unknown author')
  })

  it('removes the Windows extended path prefix from displayed repository paths', () => {
    expect(
      loreEventParsers.parseRepository('\\\\?\\E:\\Game\\godot\\projects\\godot-multi-player', [
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
    const repository = loreEventParsers.parseRepository(repositoryPath, events)
    const changes = loreEventParsers.parseChanges(events)

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

    const remoteUrl = loreEventParsers.parseRepositoryConfigValue(events, 'remote_url')
    expect(remoteUrl).toBe('lore://192.168.11.20:41337/world')
    expect(loreEventParsers.serverUrlFromRepositoryUrl(remoteUrl)).toBe('lore://192.168.11.20:41337')
  })

  it('creates the remote repository directory from server list events', () => {
    const events: LoreEvent[] = [
      {
        tagName: 'repositoryListEntry',
        data: { id: '7fcda7b9', name: 'world-building' }
      },
      { tagName: 'complete', data: { status: 0 } }
    ]

    expect(loreEventParsers.parseRemoteRepositories(events)).toEqual([{ id: '7fcda7b9', name: 'world-building' }])
  })

  it('preserves archived state from Lore branch list events', () => {
    const repository = loreEventParsers.parseRepository(repositoryPath, [
      {
        tagName: 'repositoryStatusRevision',
        data: { repository: 'repository-id', branchName: 'main' }
      }
    ])

    expect(
      loreEventParsers.parseBranches(
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

    expect(loreEventParsers.parseLayers(events, stagedEvents)).toEqual([
      expect.objectContaining({
        id: 'repository-shared:Content/Shared',
        targetPath: 'Content/Shared',
        sourceRepository: 'repository-shared',
        stagedFileCount: 3
      })
    ])
    expect(loreEventParsers.parseLinks(events, stagedEvents)).toEqual([
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

    expect(loreEventParsers.parseWorkingTreeDiffs(events)).toEqual([
      {
        path: 'Source/App.tsx',
        action: 'keep',
        patch: "@@ -1,2 +1,2 @@\n-const mode = 'dark';\n+const mode = 'light';"
      }
    ])
  })

  it('creates a file revision timeline from fileHistory events', () => {
    const events: LoreEvent[] = [
      {
        tagName: 'fileHistory',
        data: {
          path: 'Content/World.umap',
          revision: 'abcdef1234567890',
          revisionNumber: 42,
          parent: ['1234567890abcdef'],
          size: 8192,
          action: 'move'
        }
      }
    ]

    expect(loreEventParsers.parseFileHistory(events)).toEqual([
      {
        path: 'Content/World.umap',
        revision: 'abcdef1234567890',
        revisionNumber: 42,
        parent: ['1234567890abcdef'],
        size: 8192,
        action: 'move'
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
