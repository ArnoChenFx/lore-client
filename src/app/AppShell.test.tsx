import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'

import i18n from '../i18n'
import type { Repository } from '../types'
import { AppShell } from './AppShell'

const repository: Repository = {
  id: 'repository-id',
  name: 'project',
  branch: 'main',
  revision: 'revision-id',
  path: 'E:\\Project\\project',
  ahead: 0,
  behind: 0,
  online: true,
  remoteState: 'online',
  color: '#78a4ff',
  conflictCount: 0,
  unresolvedConflictCount: 0
}

describe('AppShell toast diagnostics', () => {
  beforeEach(async () => {
    // 固定语言，避免外壳中的其他多语言控件受测试执行顺序影响。
    await i18n.changeLanguage('zh-CN')
  })

  it('preserves the complete error detail as a hover-accessible value', () => {
    const detail =
      "创建远端仓库失败：creating repository on server: code: 'The request does not have valid authentication credentials'"
    const html = renderToStaticMarkup(
      <AppShell
        repository={repository}
        theme="dark"
        operationCount={0}
        repositoryTabs={[
          {
            sessionKey: repository.path.toLocaleLowerCase('en-US'),
            repository,
            displayName: repository.name,
            displayColor: repository.color,
            hasCustomName: false,
            hasCustomColor: false
          }
        ]}
        activeRepositoryId={repository.path.toLocaleLowerCase('en-US')}
        runtimeInfo={null}
        busyLabel={null}
        demoMode={false}
        toast={{ id: 1, title: '发布仓库失败', detail, tone: 'warning' }}
        onToolbarAction={() => undefined}
        onToggleTheme={() => undefined}
        onOpenCommands={() => undefined}
        onSelectRepository={() => undefined}
        onCloseRepository={() => undefined}
        onCloseOtherRepositories={() => undefined}
        onCloseAllRepositories={() => undefined}
        onReorderRepositories={() => undefined}
        onRenameRepositoryTab={() => undefined}
        onRestoreRepositoryTabName={() => undefined}
        onRepositoryTabColorChange={() => undefined}
        onAddRepository={() => undefined}
        onCloseToast={() => undefined}
        overlays={null}
      >
        <main />
      </AppShell>
    )

    expect(html).toContain(`title="${detail.replaceAll("'", '&#x27;')}"`)
    expect(html).toContain(detail.replaceAll("'", '&#x27;'))
  })
})
