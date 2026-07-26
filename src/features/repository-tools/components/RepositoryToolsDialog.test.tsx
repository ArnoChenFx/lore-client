import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'

import i18n from '../../../i18n'
import type { RepositoryToolsDialogProps } from '../types'
import { RepositoryToolsDialog } from './RepositoryToolsDialog'

describe('RepositoryToolsDialog publishing account', () => {
  beforeEach(async () => {
    // 固定语言后断言发布表单文案，避免共享 i18n 实例受其他测试执行顺序影响。
    await i18n.changeLanguage('zh-CN')
  })

  it('shows signed-in accounts and an explicit unauthenticated publishing option', () => {
    const props: RepositoryToolsDialogProps = {
      tab: 'configuration',
      repository: {
        id: 'repository-id',
        name: 'project',
        branch: 'main',
        revision: 'revision-id',
        path: 'E:\\Project\\project',
        ahead: 0,
        behind: 0,
        online: true,
        color: '#78a4ff',
        serverUrl: 'lore://server:41337',
        remoteUrl: 'lore://server:41337',
        conflictCount: 0,
        unresolvedConflictCount: 0
      },
      defaultIdentity: '',
      layers: [],
      links: [],
      loading: false,
      compositionAvailable: true,
      publishAvailable: true,
      connectedRemoteName: 'existing-project',
      publishAuthIdentities: [
        {
          authUrl: 'https://auth.example.com',
          resource: 'lore://server:41337',
          userId: 'user-1',
          displayName: 'Arno',
          authorizedDomains: ['server']
        }
      ],
      repositoryView: null,
      onTabChange: () => undefined,
      onRefresh: () => undefined,
      onSaveConfiguration: () => undefined,
      onPublish: () => undefined,
      onPushCurrentBranch: () => undefined,
      onPreviewView: async () => {
        throw new Error('unused')
      },
      onApplyView: async () => false,
      onAddLayer: async () => false,
      onRemoveLayer: async () => false,
      onAddLink: async () => false,
      onUpdateLink: async () => false,
      onRemoveLink: async () => false,
      onVerify: () => undefined,
      onCollectGarbage: () => undefined,
      onClose: () => undefined
    }

    const html = renderToStaticMarkup(<RepositoryToolsDialog {...props} />)

    expect(html).toContain('发布账户（可选）')
    expect(html).toContain('不使用账户')
    expect(html).toContain('Arno · https://auth.example.com')
    expect(html).toContain('value="existing-project"')
  })
})
