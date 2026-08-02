import { describe, expect, it } from 'vitest'

import { DEFAULT_CLIENT_PREFERENCES, getClientPreferences, updateClientPreferences } from './preferences'

describe('client preferences stored on disk', () => {
  it('stores repository tabs and the last active repository in one session snapshot', () => {
    updateClientPreferences({
      repositoryPaths: ['E:\\A', 'E:\\B'],
      activeRepositoryPath: 'E:\\A'
    })

    expect(getClientPreferences()).toMatchObject({
      repositoryPaths: ['E:\\A', 'E:\\B'],
      activeRepositoryPath: 'E:\\A'
    })
  })

  it('covers all interface state previously persisted in separate stores', () => {
    expect(DEFAULT_CLIENT_PREFERENCES).toMatchObject({
      theme: 'system',
      language: 'zh-CN',
      automaticallyCheckForUpdates: true,
      defaultIdentity: '',
      workspaceLayout: {
        sidebarWidth: 244,
        inspectorWidth: 520
      },
      inspectorTab: 'overview',
      localChangesView: 'tree',
      localChangesDiffVisible: true,
      revisionChangesView: 'tree',
      revisionChangesDiffVisible: true,
      binaryDiffVisible: true,
      binaryPreviewLimitMib: 20,
      revisionHistoryLaneMode: 'flat',
      diff: {
        contextLines: 3,
        ignoreWhitespaceEol: false,
        ignoreWhitespaceInline: false
      },
      externalDiffTools: expect.arrayContaining([
        expect.objectContaining({ kind: 'vscode', executable: 'code' }),
        expect.objectContaining({
          kind: 'beyondCompare',
          executable: 'BCompare'
        })
      ]),
      externalMergeTools: expect.arrayContaining([
        expect.objectContaining({
          kind: 'p4merge',
          arguments: expect.arrayContaining(['{merged}'])
        })
      ]),
      repositoryTabCustomizations: []
    })
  })

  it('stores the default commit identity with the remaining preferences', () => {
    updateClientPreferences({ defaultIdentity: 'yourname@example.com' })

    expect(getClientPreferences().defaultIdentity).toBe('yourname@example.com')
  })

  it('stores only redacted repository account references and deduplicates paths', () => {
    updateClientPreferences({
      authAccountBindings: [
        {
          repositoryPath: '\\\\?\\E:\\Worlds\\Lore',
          authUrl: 'https://auth.example.com',
          userId: 'user-1'
        },
        {
          repositoryPath: 'E:\\Worlds\\Lore',
          authUrl: 'https://other.example.com',
          userId: 'user-2'
        }
      ]
    })

    expect(getClientPreferences().authAccountBindings).toEqual([
      {
        repositoryPath: 'E:\\Worlds\\Lore',
        authUrl: 'https://auth.example.com',
        userId: 'user-1'
      }
    ])
    updateClientPreferences({ authAccountBindings: [] })
  })

  it('stores a structured external diff tool without a shell command string', () => {
    updateClientPreferences({
      externalDiffTools: [
        {
          id: 'diff-studio',
          kind: 'custom',
          name: 'Studio Diff',
          executable: 'E:\\Tools\\Studio Diff.exe',
          arguments: ['--left', '{before}', '--right', '{after}'],
          primary: true
        }
      ]
    })

    expect(getClientPreferences().externalDiffTools).toEqual([
      {
        id: 'diff-studio',
        kind: 'custom',
        name: 'Studio Diff',
        executable: 'E:\\Tools\\Studio Diff.exe',
        arguments: ['--left', '{before}', '--right', '{after}'],
        primary: true
      }
    ])
  })

  it('stores the application language and accepts only supported locales', () => {
    updateClientPreferences({ language: 'en-US' })
    expect(getClientPreferences().language).toBe('en-US')

    updateClientPreferences({ language: 'zh-CN' })
    expect(getClientPreferences().language).toBe('zh-CN')
  })

  it('enables automatic update checks by default and persists the opt-out', () => {
    expect(DEFAULT_CLIENT_PREFERENCES.automaticallyCheckForUpdates).toBe(true)

    updateClientPreferences({ automaticallyCheckForUpdates: false })
    expect(getClientPreferences().automaticallyCheckForUpdates).toBe(false)

    updateClientPreferences({ automaticallyCheckForUpdates: true })
    expect(getClientPreferences().automaticallyCheckForUpdates).toBe(true)
  })

  it('normalizes Windows extended paths and deduplicates repository tabs', () => {
    updateClientPreferences({
      repositoryPaths: ['\\\\?\\E:\\Worlds\\Lore', 'E:\\Worlds\\Lore'],
      activeRepositoryPath: '\\\\?\\E:\\Worlds\\Lore'
    })

    expect(getClientPreferences()).toMatchObject({
      repositoryPaths: ['E:\\Worlds\\Lore'],
      activeRepositoryPath: 'E:\\Worlds\\Lore'
    })
  })

  it('persists safe repository tab names and controlled colors by normalized path', () => {
    updateClientPreferences({
      repositoryTabCustomizations: [
        {
          repositoryPath: '\\\\?\\E:\\Worlds\\Lore',
          name: '  Environment\r\n',
          color: '#e47a3f'
        },
        {
          repositoryPath: 'E:\\Worlds\\Lore',
          name: 'Duplicate',
          color: '#d87568'
        },
        {
          repositoryPath: 'E:\\Invalid',
          color: 'hotpink'
        }
      ]
    })

    expect(getClientPreferences().repositoryTabCustomizations).toEqual([
      {
        repositoryPath: 'E:\\Worlds\\Lore',
        name: 'Environment',
        color: '#e47a3f'
      }
    ])

    updateClientPreferences({ repositoryTabCustomizations: [] })
  })

  it('persists and bounds shared Diff preferences', () => {
    updateClientPreferences({
      diff: {
        contextLines: 999,
        ignoreWhitespaceEol: true,
        ignoreWhitespaceInline: true
      }
    })

    expect(getClientPreferences().diff).toEqual({
      contextLines: 100,
      ignoreWhitespaceEol: true,
      ignoreWhitespaceInline: true
    })
  })

  it('preserves Diff preference identity across layout-only updates', () => {
    const before = getClientPreferences()

    updateClientPreferences({
      revisionChangesBrowserWidth: before.revisionChangesBrowserWidth + 1
    })

    const after = getClientPreferences()
    expect(after.revisionChangesBrowserWidth).toBe(before.revisionChangesBrowserWidth + 1)
    // React effect 以对象身份判断依赖；无关布局更新不得伪装成 Diff 参数变化。
    expect(after.diff).toBe(before.diff)
  })

  it('replaces Diff preference identity when a Diff value changes', () => {
    const before = getClientPreferences()

    updateClientPreferences({
      diff: {
        ...before.diff,
        ignoreWhitespaceEol: !before.diff.ignoreWhitespaceEol
      }
    })

    const after = getClientPreferences()
    expect(after.diff).not.toBe(before.diff)
    expect(after.diff.ignoreWhitespaceEol).toBe(!before.diff.ignoreWhitespaceEol)
  })

  it('persists the two Diff panel visibility preferences independently', () => {
    updateClientPreferences({
      localChangesDiffVisible: false,
      revisionChangesDiffVisible: true
    })

    expect(getClientPreferences()).toMatchObject({
      localChangesDiffVisible: false,
      revisionChangesDiffVisible: true
    })

    updateClientPreferences({
      revisionChangesDiffVisible: false
    })

    expect(getClientPreferences()).toMatchObject({
      localChangesDiffVisible: false,
      revisionChangesDiffVisible: false
    })
  })

  it('shows binary Diff by default and persists its visibility independently', () => {
    expect(DEFAULT_CLIENT_PREFERENCES.binaryDiffVisible).toBe(true)

    updateClientPreferences({ binaryDiffVisible: false })
    expect(getClientPreferences().binaryDiffVisible).toBe(false)

    updateClientPreferences({ binaryDiffVisible: true })
    expect(getClientPreferences().binaryDiffVisible).toBe(true)
  })

  it('persists and bounds the binary preview size limit in MiB', () => {
    expect(DEFAULT_CLIENT_PREFERENCES.binaryPreviewLimitMib).toBe(20)

    updateClientPreferences({ binaryPreviewLimitMib: 64.4 })
    expect(getClientPreferences().binaryPreviewLimitMib).toBe(64)

    updateClientPreferences({ binaryPreviewLimitMib: 0 })
    expect(getClientPreferences().binaryPreviewLimitMib).toBe(1)

    updateClientPreferences({ binaryPreviewLimitMib: 2048 })
    expect(getClientPreferences().binaryPreviewLimitMib).toBe(2048)

    updateClientPreferences({ binaryPreviewLimitMib: 20 })
  })

  it('uses flat mode by default, persists topology mode, and rejects unknown modes', () => {
    expect(DEFAULT_CLIENT_PREFERENCES.revisionHistoryLaneMode).toBe('flat')

    updateClientPreferences({ revisionHistoryLaneMode: 'topology' })
    expect(getClientPreferences().revisionHistoryLaneMode).toBe('topology')

    updateClientPreferences({
      revisionHistoryLaneMode: 'unsupported' as typeof DEFAULT_CLIENT_PREFERENCES.revisionHistoryLaneMode
    })
    expect(getClientPreferences().revisionHistoryLaneMode).toBe('flat')
  })
})
