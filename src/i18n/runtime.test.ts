import { beforeEach, describe, expect, it } from 'vitest'

import i18n, { getAppLanguage, setAppLanguage, t } from './'
import zhCN from './locales/zh-CN'

describe('i18n runtime', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN')
  })

  it('returns Simplified Chinese resources for semantic keys in Chinese mode', () => {
    setAppLanguage('zh-CN')
    expect(getAppLanguage()).toBe('zh-CN')
    expect(t('clientSettings')).toBe(zhCN.clientSettings)
    expect(t('revisionLaneFlat')).toBe('平铺模式')
    expect(t('status.changedFilesFound', { count: 3 })).toBe(zhCN.status.changedFilesFound.replace('{{count}}', '3'))
  })

  it('translates static semantic keys in English mode', async () => {
    await i18n.changeLanguage('en-US')
    expect(t('clientSettings')).toBe('Client Settings')
    expect(t('localChanges')).toBe('Local Changes')
    expect(t('revisionLaneFlat')).toBe('Flat mode')
  })

  it('supports interpolation and plurals in English mode', async () => {
    await i18n.changeLanguage('en-US')
    expect(t('status.changedFilesFound', { count: 12 })).toBe('Found 12 changed files')
    expect(t('status.unresolvedConflicts', { count: 1 })).toBe('1 unresolved conflict')
    expect(t('status.unresolvedConflicts', { count: 3 })).toBe('3 unresolved conflicts')
    expect(t('confirm.mergeBranch', { source: 'feature/audio', target: 'main' })).toBe(
      'Merge “feature/audio” into “main”?'
    )
    expect(t('status.cherryPickOnto', { branch: 'main' })).toBe('Cherry-pick onto “main”')
    expect(t('status.connectedRepositories', { count: 3 })).toBe('Connected · 3 repositories')
    expect(t('status.repositoriesOpen', { count: 4 })).toBe('4 repositories open')
    expect(t('status.fileCount', { count: 1 })).toBe('1 file')
    expect(t('status.filesSelected', { count: 8, selectedCount: 1 })).toBe('8 files · 1 selected')
    expect(t('status.revisionLabel', { number: 16, id: '57bc72f2' })).toBe('Revision #16 · 57bc72f2')
    expect(t('status.hoursAgo', { count: 4 })).toBe('4 hours ago')
    expect(t('status.workspaceSwitchedTo', { name: 'release/0.8' })).toBe('The workspace switched to release/0.8')
  })

  it('updates semantic keys after the language changes', async () => {
    await i18n.changeLanguage('en-US')
    expect(t('localChanges')).toBe('Local Changes')
    await i18n.changeLanguage('zh-CN')
    expect(t('localChanges')).toBe(zhCN.localChanges)
  })
})
