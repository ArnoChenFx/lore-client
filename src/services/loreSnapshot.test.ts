import { beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '../i18n'

/*
 * 使用动态导入让模拟函数先完成初始化，再加载被测服务。这样既兼容 Vitest 对
 * `vi.mock` 的提升语义，也兼容项目交付命令使用的 Bun test（它没有 vi.hoisted）。
 */
const invokeMock = vi.fn()
let repositoryStatusEvents: Array<{ tagName: string; data: Record<string, unknown> }> = []
let branchListEvents: Array<{ tagName: string; data: Record<string, unknown> }> = []
let conflictSessionResponse: unknown = null

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  isTauri: () => true,
  // lore.ts 同时导出通知订阅能力；独立运行本文件时 Event API 需要看到该命名导出。
  transformCallback: vi.fn()
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn()
}))

const {
  cloneRepository,
  loadFileHistory,
  loadRepositorySnapshot,
  loadRemoteRepositoryInfo,
  loadRevisionChanges,
  loadRevisionDiff,
  loadRevisionHistory,
  listAuthIdentities,
  listRemoteRepositories,
  loreEventParsers,
  publishRepository,
  runConflictAction,
  switchBranch
} = await import('./lore')

describe('repository snapshot branch loading', () => {
  beforeEach(async () => {
    // 结构化错误映射断言依赖当前界面语言，显式隔离其他测试文件对全局 i18n 的切换。
    await i18n.changeLanguage('en-US')
    invokeMock.mockReset()
    repositoryStatusEvents = [
      {
        tagName: 'repositoryStatusRevision',
        data: {
          repository: 'repository-id',
          branchName: 'main',
          revision: 'old-revision'
        }
      }
    ]
    branchListEvents = [
      {
        tagName: 'branchListEntry',
        data: {
          id: 'main-id',
          name: 'main',
          latest: 'main-tip',
          location: 'local',
          isCurrent: true
        }
      }
    ]
    conflictSessionResponse = null
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'lore_repository_status') {
        return {
          operation: 'repository.status',
          status: 0,
          events: repositoryStatusEvents
        }
      }
      if (command === 'lore_revision_history') {
        return {
          operation: 'revision.history',
          status: 0,
          events: [
            {
              tagName: 'revisionHistoryEntry',
              data: { revision: 'main-tip', revisionNumber: 2, parent: ['old-revision'] }
            },
            {
              tagName: 'revisionHistoryEntry',
              data: { revision: 'old-revision', revisionNumber: 1, parent: [] }
            }
          ]
        }
      }
      if (command === 'lore_conflict_session') {
        return conflictSessionResponse
      }
      if (command === 'lore_conflict_action') {
        return {
          operation: 'branch.merge-resolve-mine',
          status: 0,
          durationMs: 1,
          events: []
        }
      }
      if (command === 'lore_branch_list') {
        return {
          operation: 'branch.list',
          status: 0,
          events: branchListEvents
        }
      }
      if (command === 'lore_branch_switch') {
        return {
          operation: 'branch.switch',
          status: 0,
          events: []
        }
      }
      if (command === 'lore_tag_list') {
        return []
      }
      if (command === 'lore_file_history') {
        return {
          operation: 'file.history',
          status: 0,
          events: []
        }
      }
      if (command === 'lore_revision_changes') {
        return [
          {
            path: 'Scenes/Main.tscn',
            action: 'add',
            size: 128
          },
          {
            path: 'assets/hero.glb',
            sourcePath: 'assets/legacy-hero.glb',
            action: 'move',
            size: 2048
          }
        ]
      }
      if (command === 'lore_revision_diff') {
        return {
          operation: 'file.diff.revision',
          status: 0,
          durationMs: 1,
          events: [
            {
              tagName: 'fileDiff',
              data: {
                path: 'Scenes/Main.tscn',
                action: 'add',
                patch: '+[node name="Main"]'
              }
            }
          ]
        }
      }
      if (command === 'lore_repository_info_remote') {
        return {
          operation: 'repository.info',
          status: 0,
          durationMs: 1,
          events: [
            {
              tagName: 'repositoryData',
              data: {
                id: 'remote-id',
                name: 'world',
                remoteUrl: 'lore://127.0.0.1:41337',
                description: 'Open world assets',
                defaultBranchName: 'main',
                defaultBranch: 'branch-id',
                creator: 'Artist <artist@example.com>',
                created: 1_743_724_799,
                permissions: 'read',
                targetRevision: 'latest-revision'
              }
            }
          ]
        }
      }
      if (command === 'lore_repository_clone') {
        return {
          destinationPath: 'E:\\Worlds\\world',
          result: {
            operation: 'repository.clone',
            status: 0,
            durationMs: 1,
            events: []
          }
        }
      }
      if (command === 'lore_repository_config_get') {
        return {
          operation: 'repository.config-get',
          status: 0,
          events: [
            {
              tagName: 'repositoryConfigGet',
              data: { key: args.key, value: '' }
            }
          ]
        }
      }
      throw new Error(`The test does not handle command: ${command}`)
    })
  })

  it('enriches stored authentication identities with Auth-issued display names', async () => {
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'lore_auth_list') {
        return {
          operation: 'auth.list',
          status: 0,
          events: [
            {
              tagName: 'authIdentity',
              data: {
                authUrl: 'https://auth.example.com',
                resource: '',
                userId: '2',
                authorizedDomains: 'example.com',
                expires: 1_800_000_000_000
              }
            },
            {
              tagName: 'authIdentity',
              data: {
                authUrl: 'https://auth.example.com',
                resource: 'lore://example.com/repository',
                userId: '2',
                authorizedDomains: 'example.com',
                expires: 1_800_000_000_000
              }
            }
          ]
        }
      }
      if (command === 'lore_auth_local_user_info') {
        expect(args).toEqual({
          authUrl: 'https://auth.example.com',
          userIds: ['2']
        })
        return {
          operation: 'auth.local-user-info',
          status: 0,
          events: [
            {
              tagName: 'authUserInfo',
              data: { id: '2', name: 'Arno' }
            }
          ]
        }
      }
      throw new Error(`The test does not handle command: ${command}`)
    })

    await expect(listAuthIdentities()).resolves.toEqual([
      {
        authUrl: 'https://auth.example.com',
        resource: '',
        userId: '2',
        authorizedDomains: ['example.com'],
        expiresAt: 1_800_000_000_000,
        displayName: 'Arno'
      },
      {
        authUrl: 'https://auth.example.com',
        resource: 'lore://example.com/repository',
        userId: '2',
        authorizedDomains: ['example.com'],
        expiresAt: 1_800_000_000_000,
        displayName: 'Arno'
      }
    ])
  })

  it('keeps account identities when display-name resolution fails', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'lore_auth_list') {
        return {
          operation: 'auth.list',
          status: 0,
          events: [
            {
              tagName: 'authIdentity',
              data: {
                authUrl: 'https://auth.example.com',
                resource: '',
                userId: '2',
                authorizedDomains: '',
                expires: 0
              }
            }
          ]
        }
      }
      if (command === 'lore_auth_local_user_info') {
        throw new Error('Local credential is unavailable')
      }
      throw new Error(`The test does not handle command: ${command}`)
    })

    await expect(listAuthIdentities()).resolves.toEqual([
      {
        authUrl: 'https://auth.example.com',
        resource: '',
        userId: '2',
        authorizedDomains: [],
        expiresAt: undefined,
        displayName: undefined
      }
    ])
  })

  it('includes archived local branches in a complete snapshot request', async () => {
    await loadRepositorySnapshot('E:\\Worlds\\RealLore')

    expect(invokeMock).toHaveBeenCalledWith('lore_branch_list', {
      repositoryPath: 'E:\\Worlds\\RealLore',
      includeArchived: true
    })
  })

  it('anchors history at the current branch tip while keeping HEAD on the older workspace revision', async () => {
    const snapshot = await loadRepositorySnapshot('E:\\Worlds\\RealLore')

    expect(invokeMock).toHaveBeenCalledWith('lore_revision_history', {
      repositoryPath: 'E:\\Worlds\\RealLore',
      limit: 100,
      revision: 'main-tip'
    })
    expect(snapshot.repository.revision).toBe('old-revision')
    expect(snapshot.revisions[0]?.branchPointers).toEqual([{ id: 'local:main-id', name: 'main', kind: 'local' }])
    expect(snapshot.revisions[1]?.branchPointers).toEqual([{ id: 'head', name: 'HEAD', kind: 'head' }])
  })

  it('uses the status branch name when an offline Branch list omits the current marker', async () => {
    branchListEvents[0]!.data.isCurrent = false

    await loadRepositorySnapshot('E:\\Worlds\\RealLore')

    expect(invokeMock).toHaveBeenCalledWith('lore_revision_history', {
      repositoryPath: 'E:\\Worlds\\RealLore',
      limit: 100,
      revision: 'main-tip'
    })
  })

  it('opens a newly initialized repository without querying the zero Revision', async () => {
    const zeroRevision = '0'.repeat(64)
    repositoryStatusEvents[0]!.data.revision = zeroRevision
    branchListEvents[0]!.data.latest = zeroRevision
    invokeMock.mockImplementationOnce(async () => ({
      operation: 'repository.status',
      status: 0,
      events: repositoryStatusEvents
    }))
    invokeMock.mockImplementationOnce(async () => ({
      operation: 'branch.list',
      status: 0,
      events: branchListEvents
    }))
    invokeMock.mockImplementationOnce(async (command: string, args: Record<string, unknown>) => {
      if (command === 'lore_revision_history' && args.revision === zeroRevision) {
        throw new Error(`revision not found: ${zeroRevision}`)
      }
      return {
        operation: 'revision.history',
        status: 0,
        events: []
      }
    })

    await expect(loadRepositorySnapshot('E:\\Worlds\\NewLore')).resolves.toMatchObject({
      repository: {
        revision: ''
      },
      revisions: []
    })
    expect(invokeMock).toHaveBeenCalledWith('lore_revision_history', {
      repositoryPath: 'E:\\Worlds\\NewLore',
      limit: 100,
      revision: null
    })
  })

  it('passes the exact branch tip when checking out the current branch again', async () => {
    await switchBranch('E:\\Worlds\\RealLore', 'main', 'main-tip')

    expect(invokeMock).toHaveBeenCalledWith('lore_branch_switch', {
      repositoryPath: 'E:\\Worlds\\RealLore',
      branch: 'main',
      revision: 'main-tip'
    })
  })

  it('queries file history from an exact revision without also passing a branch', async () => {
    await loadFileHistory('E:\\Worlds\\RealLore', 'Content/Committed.txt', {
      branch: 'main',
      revision: 'abcdef1234567890'
    })

    expect(invokeMock).toHaveBeenCalledWith('lore_file_history', {
      repositoryPath: 'E:\\Worlds\\RealLore',
      path: 'Content/Committed.txt',
      branch: null,
      revision: 'abcdef1234567890',
      length: 100
    })
  })

  it('requests only tree metadata for a revision change list and maps stable file DTOs', async () => {
    const changes = await loadRevisionChanges(
      'E:\\Worlds\\RealLore',
      null,
      'cff2660aab177e854f14902a03f1f95b7ca21c85d756b430cd38f4ceab6a6b46'
    )

    expect(invokeMock).toHaveBeenCalledWith('lore_revision_changes', {
      repositoryPath: 'E:\\Worlds\\RealLore',
      sourceRevision: null,
      targetRevision: 'cff2660aab177e854f14902a03f1f95b7ca21c85d756b430cd38f4ceab6a6b46'
    })
    expect(changes).toEqual([
      expect.objectContaining({
        id: 'Scenes/Main.tscn',
        path: 'Scenes',
        name: 'Main.tscn',
        status: 'added',
        binary: false
      }),
      expect.objectContaining({
        id: 'assets/hero.glb',
        path: 'assets',
        name: 'hero.glb',
        status: 'renamed',
        binary: true,
        previousPath: 'assets/legacy-hero.glb'
      })
    ])
  })

  it('passes only the current primary path to the complete revision diff command', async () => {
    const diffs = await loadRevisionDiff(
      'E:\\Worlds\\RealLore',
      null,
      'cff2660aab177e854f14902a03f1f95b7ca21c85d756b430cd38f4ceab6a6b46',
      ['Scenes/Main.tscn']
    )

    expect(invokeMock).toHaveBeenCalledWith('lore_revision_diff', {
      repositoryPath: 'E:\\Worlds\\RealLore',
      sourceRevision: null,
      targetRevision: 'cff2660aab177e854f14902a03f1f95b7ca21c85d756b430cd38f4ceab6a6b46',
      paths: ['Scenes/Main.tscn'],
      contextLines: 3,
      ignoreWhitespaceEol: false,
      ignoreWhitespaceInline: false
    })
    expect(diffs).toEqual([
      {
        path: 'Scenes/Main.tscn',
        action: 'add',
        patch: '+[node name="Main"]'
      }
    ])
  })

  it('passes persisted whitespace and context options to Lore Diff', async () => {
    await loadRevisionDiff('E:\\Worlds\\RealLore', null, 'target', ['Scenes/Main.tscn'], {
      contextLines: 12,
      ignoreWhitespaceEol: true,
      ignoreWhitespaceInline: true
    })

    expect(invokeMock).toHaveBeenCalledWith(
      'lore_revision_diff',
      expect.objectContaining({
        contextLines: 12,
        ignoreWhitespaceEol: true,
        ignoreWhitespaceInline: true
      })
    )
  })

  it('passes the stable Revision, Branch, date, only-branch, and limit history filters to Lore', async () => {
    const snapshot = await loadRepositorySnapshot('E:\\Worlds\\RealLore')
    invokeMock.mockClear()

    await loadRevisionHistory(snapshot.repository, snapshot.branches, {
      revision: 'history-start',
      branch: 'main',
      beforeDate: 1_743_724_799,
      onlyBranch: true,
      limit: 250
    })

    expect(invokeMock).toHaveBeenCalledWith('lore_revision_history', {
      repositoryPath: 'E:\\Worlds\\RealLore',
      limit: 250,
      revision: 'history-start',
      branch: 'main',
      date: 1_743_724_799,
      onlyBranch: true
    })
  })

  it('resolves revision user IDs in one repository-scoped Auth request and preserves unresolved identities', async () => {
    const repository = loreEventParsers.parseRepository('E:\\Worlds\\RealLore', [
      {
        tagName: 'repositoryStatusRevision',
        data: {
          repository: 'repository-id',
          branchName: 'main',
          revision: 'tip',
          remoteAvailable: true,
          remoteAuthorized: true
        }
      }
    ])
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'lore_revision_history') {
        return {
          operation: 'revision.history',
          status: 0,
          events: [
            {
              tagName: 'revisionHistoryEntry',
              data: { revision: 'tip', revisionNumber: 2, parent: ['base'] }
            },
            {
              tagName: 'metadata',
              data: { key: 'committed-by', value: { tagName: 'string', data: 'user-42' } }
            },
            {
              tagName: 'metadata',
              data: { key: 'created-by', value: { tagName: 'string', data: 'creator-fallback' } }
            },
            {
              tagName: 'revisionHistoryEntry',
              data: { revision: 'base', revisionNumber: 1, parent: [] }
            },
            {
              tagName: 'metadata',
              data: { key: 'created-by', value: { tagName: 'string', data: 'Artist Team' } }
            }
          ]
        }
      }
      if (command === 'lore_auth_user_info') {
        expect(args).toEqual({
          repositoryPath: 'E:\\Worlds\\RealLore',
          userIds: ['user-42', 'Artist Team']
        })
        return {
          operation: 'auth.user-info',
          status: 0,
          events: [
            {
              tagName: 'authUserInfo',
              data: { id: 'user-42', name: 'Arno Chen <arno@example.com>' }
            }
          ]
        }
      }
      throw new Error(`The test does not handle command: ${command}`)
    })

    const revisions = await loadRevisionHistory(repository, [], { onlyBranch: false, limit: 100 })

    expect(revisions[0]).toMatchObject({ author: 'Arno Chen', authorEmail: 'arno@example.com' })
    expect(revisions[1]).toMatchObject({ author: 'Artist Team', authorEmail: undefined })
    expect(invokeMock).toHaveBeenCalledTimes(2)
  })

  it('keeps revision identities when remote author resolution is unavailable', async () => {
    const repository = loreEventParsers.parseRepository('E:\\Worlds\\RealLore', [
      {
        tagName: 'repositoryStatusRevision',
        data: {
          repository: 'repository-id',
          branchName: 'main',
          revision: 'tip',
          remoteAvailable: true,
          remoteAuthorized: true
        }
      }
    ])
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'lore_revision_history') {
        return {
          operation: 'revision.history',
          status: 0,
          events: [
            {
              tagName: 'revisionHistoryEntry',
              data: { revision: 'tip', revisionNumber: 1, parent: [] }
            },
            {
              tagName: 'metadata',
              data: { key: 'committed-by', value: { tagName: 'string', data: 'user-42' } }
            }
          ]
        }
      }
      if (command === 'lore_auth_user_info') {
        throw new Error('Auth service unavailable')
      }
      throw new Error(`The test does not handle command: ${command}`)
    })

    await expect(loadRevisionHistory(repository, [], { onlyBranch: false, limit: 100 })).resolves.toEqual([
      expect.objectContaining({ author: 'user-42', authorEmail: undefined })
    ])
  })

  it('uses only the bound local Auth profile while the repository is offline', async () => {
    const repository = loreEventParsers.parseRepository('E:\\Worlds\\RealLore', [
      {
        tagName: 'repositoryStatusRevision',
        data: { repository: 'repository-id', branchName: 'main', revision: 'tip' }
      }
    ])
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'lore_revision_history') {
        return {
          operation: 'revision.history',
          status: 0,
          events: [
            { tagName: 'revisionHistoryEntry', data: { revision: 'tip', revisionNumber: 1, parent: [] } },
            {
              tagName: 'metadata',
              data: { key: 'committed-by', value: { tagName: 'string', data: 'user-42' } }
            }
          ]
        }
      }
      if (command === 'lore_auth_user_info') throw new Error('Offline history must not query the remote Auth service')
      if (command === 'lore_auth_repository_local_user_info') {
        expect(args).toEqual({ repositoryPath: 'E:\\Worlds\\RealLore', userIds: ['user-42'] })
        return {
          operation: 'auth.repository-local-user-info',
          status: 0,
          events: [{ tagName: 'authUserInfo', data: { id: 'user-42', name: 'Arno Chen' } }]
        }
      }
      throw new Error(`The test does not handle command: ${command}`)
    })

    await expect(loadRevisionHistory(repository, [], { onlyBranch: false, limit: 100 })).resolves.toEqual([
      expect.objectContaining({ author: 'Arno Chen', authorEmail: undefined })
    ])
  })

  it('loads remote repository details before Clone', async () => {
    await expect(loadRemoteRepositoryInfo('lore://127.0.0.1:41337', 'world')).resolves.toMatchObject({
      id: 'remote-id',
      name: 'world',
      description: 'Open world assets',
      defaultBranch: 'main',
      creator: 'Artist <artist@example.com>',
      permissions: 'read',
      targetRevision: 'latest-revision'
    })
  })

  it('enriches the server repository directory with remote descriptions', async () => {
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'lore_repository_list') {
        return {
          operation: 'repository.list',
          status: 0,
          events: [
            {
              tagName: 'repositoryListEntry',
              data: { id: 'remote-id', name: 'world' }
            }
          ]
        }
      }
      if (command === 'lore_repository_info_remote') {
        return {
          operation: 'repository.info',
          status: 0,
          events: [
            {
              tagName: 'repositoryData',
              data: {
                id: 'remote-id',
                name: args.repositoryName,
                description: 'Open world assets'
              }
            }
          ]
        }
      }
      throw new Error(`Unexpected command: ${command}`)
    })

    await expect(listRemoteRepositories('lore://127.0.0.1:41337', 'artist-id')).resolves.toEqual([
      expect.objectContaining({
        id: 'remote-id',
        name: 'world',
        description: 'Open world assets'
      })
    ])
    expect(invokeMock).toHaveBeenCalledWith('lore_repository_info_remote', {
      serverUrl: 'lore://127.0.0.1:41337',
      repositoryName: 'world',
      userId: 'artist-id'
    })
  })

  it('keeps a repository list entry when its detail request fails', async () => {
    invokeMock
      .mockResolvedValueOnce({
        operation: 'repository.list',
        status: 0,
        events: [{ tagName: 'repositoryListEntry', data: { id: 'remote-id', name: 'world' } }]
      })
      .mockRejectedValueOnce(new Error('Repository info unavailable'))

    await expect(listRemoteRepositories('lore://127.0.0.1:41337')).resolves.toEqual([
      { id: 'remote-id', name: 'world' }
    ])
  })

  it('passes the bound authentication account when publishing a local repository', async () => {
    invokeMock.mockResolvedValueOnce({
      repositoryUrl: 'lore://192.168.11.20:41337/test-new-repo',
      remoteCreated: true,
      configurationUpdated: true,
      pushed: true,
      createResult: {
        operation: 'repository.create.remote',
        status: 0,
        events: []
      },
      pushResult: {
        operation: 'branch.push',
        status: 0,
        events: []
      }
    })

    await publishRepository(
      'E:\\Worlds\\NewLore',
      'new-lore',
      'New Lore repository',
      'Artist <artist@example.com>',
      '',
      'lore://192.168.11.20:41337',
      'main',
      'authenticated-user-id'
    )

    expect(invokeMock).toHaveBeenCalledWith('lore_repository_publish', {
      repositoryPath: 'E:\\Worlds\\NewLore',
      repositoryName: 'new-lore',
      description: 'New Lore repository',
      identity: 'Artist <artist@example.com>',
      defaultIdentity: null,
      serverUrl: 'lore://192.168.11.20:41337',
      branch: 'main',
      userId: 'authenticated-user-id',
      useAuthAccount: true
    })
  })

  it('explicitly disables repository binding fallback for anonymous publishing', async () => {
    invokeMock.mockResolvedValueOnce({
      repositoryUrl: 'lore://192.168.11.20:41337/public-repo',
      remoteCreated: true,
      configurationUpdated: true,
      pushed: true,
      createResult: {
        operation: 'repository.create.remote',
        status: 0,
        events: []
      },
      pushResult: {
        operation: 'branch.push',
        status: 0,
        events: []
      }
    })

    await publishRepository(
      'E:\\Worlds\\PublicLore',
      'public-repo',
      '',
      'Artist <artist@example.com>',
      '',
      'lore://192.168.11.20:41337',
      'main'
    )

    expect(invokeMock).toHaveBeenCalledWith('lore_repository_publish', {
      repositoryPath: 'E:\\Worlds\\PublicLore',
      repositoryName: 'public-repo',
      description: '',
      identity: 'Artist <artist@example.com>',
      defaultIdentity: null,
      serverUrl: 'lore://192.168.11.20:41337',
      branch: 'main',
      userId: null,
      useAuthAccount: false
    })
  })

  it('passes every supported advanced Clone option through the stable service boundary', async () => {
    await cloneRepository('lore://127.0.0.1:41337', 'world', 'E:\\Worlds', 'world', 'C:\\views\\world.view', {
      useSharedStore: true,
      sharedStorePath: 'D:\\LoreStore',
      revision: 'release/1.0',
      bare: false,
      directFileIo: true,
      layer: {
        repository: 'world-lighting',
        metadataKey: 'build-id'
      },
      dependency: {
        rootFiles: ['Content/World.umap'],
        tags: ['runtime'],
        recursive: true,
        depthLimit: 4
      }
    })

    expect(invokeMock).toHaveBeenCalledWith('lore_repository_clone', {
      serverUrl: 'lore://127.0.0.1:41337',
      repositoryName: 'world',
      destinationParent: 'E:\\Worlds',
      directoryName: 'world',
      viewPath: 'C:\\views\\world.view',
      targetRevision: 'release/1.0',
      bare: false,
      directFileIo: true,
      layerRepository: 'world-lighting',
      layerMetadataKey: 'build-id',
      useSharedStore: true,
      sharedStorePath: 'D:\\LoreStore',
      dependencyRootFiles: ['Content/World.umap'],
      dependencyTags: ['runtime'],
      dependencyRecursive: true,
      dependencyDepthLimit: 4,
      userId: null
    })
  })

  it('localizes structured Clone validation failures before they reach the dialog', async () => {
    await i18n.changeLanguage('zh-CN')
    invokeMock.mockRejectedValueOnce({
      code: 'clone_bare_materialization_options',
      message: 'Bare Clone cannot be combined with materialization options'
    })

    await expect(
      cloneRepository('lore://127.0.0.1:41337', 'world', 'E:\\Worlds', 'world', undefined, {
        useSharedStore: false,
        bare: true
      })
    ).rejects.toThrow('Bare 克隆不能同时使用选择性同步、直接文件 I/O、Layer 或依赖物化选项。')
  })

  it('passes stable conflict kind, action, and repository-relative paths to Rust', async () => {
    await runConflictAction('E:\\Worlds\\RealLore', 'merge', 'mine', ['Content/Conflict.txt'])

    expect(invokeMock).toHaveBeenCalledWith('lore_conflict_action', {
      repositoryPath: 'E:\\Worlds\\RealLore',
      operation: 'merge',
      action: 'mine',
      paths: ['Content/Conflict.txt']
    })
  })

  it('restores a persistent conflict session into the snapshot when status contains conflict files', async () => {
    repositoryStatusEvents.push({
      tagName: 'repositoryStatusFile',
      data: {
        path: 'Content/Conflict.txt',
        action: 'edit',
        flagStaged: true,
        flagConflict: true,
        flagConflictUnresolved: true
      }
    })
    conflictSessionResponse = {
      kind: 'merge',
      currentRevision: 'current-revision',
      stagedRevision: 'staged-revision',
      incomingRevision: 'incoming-revision'
    }

    const snapshot = await loadRepositorySnapshot('E:\\Worlds\\RealLore')

    expect(invokeMock).toHaveBeenCalledWith('lore_conflict_session', {
      repositoryPath: 'E:\\Worlds\\RealLore'
    })
    expect(snapshot.conflictSession).toEqual(conflictSessionResponse)
    expect(snapshot.changes[0]).toMatchObject({
      id: 'Content/Conflict.txt',
      conflict: true,
      conflictUnresolved: true
    })
  })

  it('maps structured conflict errors to the active locale instead of exposing the Rust message', async () => {
    invokeMock.mockRejectedValueOnce({
      code: 'unknown_conflict_operation',
      message: 'Raw diagnostic from the Rust boundary'
    })

    await expect(runConflictAction('E:\\Worlds\\RealLore', 'merge', 'mine', ['Content/Conflict.txt'])).rejects.toThrow(
      'The current conflict operation could not be identified. Refresh the repository and try again.'
    )
  })
})
