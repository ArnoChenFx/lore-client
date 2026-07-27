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
      ])
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
