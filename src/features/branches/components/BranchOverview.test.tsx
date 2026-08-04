import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import i18n from '../../../i18n'
import type { Branch } from '../../../types'
import { activeOverviewBranches, BranchOverview, groupOverviewBranches } from './BranchOverview'

const currentBranch: Branch = {
  id: 'local:main',
  name: 'main',
  current: true,
  latest: '57bc72f2aaaaaaaa'
}

const archivedBranch: Branch = {
  id: 'local:ccc',
  name: 'ccc',
  latest: '0000000000000000',
  archived: true
}

const remoteBranch: Branch = {
  id: 'remote:main',
  name: 'main',
  remote: true,
  latest: '10a69776bbbbbbbb'
}

describe('archived branch filtering in the branch overview', () => {
  it('excludes archived branches from active pointers', () => {
    expect(activeOverviewBranches([currentBranch, archivedBranch, remoteBranch])).toEqual([currentBranch, remoteBranch])
  })

  it('groups local and remote branches and sorts each path level', () => {
    const branches: Branch[] = [
      { id: 'local:root', name: 'Alpha' },
      { id: 'remote:root', name: 'Zulu', remote: true },
      { id: 'local:feat-leaf', name: 'feat/zulu' },
      { id: 'remote:origin-main', name: 'origin/main', remote: true },
      { id: 'local:zeta-child', name: 'zeta/root' },
      { id: 'local:feat-alpha', name: 'feat/alpha' },
      { id: 'remote:origin-release', name: 'origin/release/0.8', remote: true },
      { id: 'local:feat-api', name: 'feat/api/Beta' },
      archivedBranch
    ]

    const groups = groupOverviewBranches(branches)

    expect(groups.localBranches.map((branch) => branch.name)).toEqual([
      'feat/api/Beta',
      'feat/alpha',
      'feat/zulu',
      'zeta/root',
      'Alpha'
    ])
    expect(groups.remoteBranches.map((branch) => branch.name)).toEqual(['origin/release/0.8', 'origin/main', 'Zulu'])
  })

  it('does not claim an unknown branch sync state is synced', async () => {
    await i18n.changeLanguage('zh-CN')
    const markup = renderToStaticMarkup(
      <BranchOverview
        branches={[currentBranch]}
        demoMode={false}
        selectedBranchId={currentBranch.id}
        onSelect={() => undefined}
        onCheckout={() => undefined}
        onContextMenu={() => undefined}
        onCreate={() => undefined}
      />
    )

    expect(markup).not.toContain('已同步')
    expect(markup).toContain('同步状态未知')
    expect(markup).toContain('未知创建者')
    expect(markup).not.toContain('&lt;unknown&gt;')
  })

  it('shows synced only when the branch carries explicit evidence', async () => {
    await i18n.changeLanguage('zh-CN')
    const syncedBranch: Branch = { ...currentBranch, syncState: 'synced' }
    const markup = renderToStaticMarkup(
      <BranchOverview
        branches={[syncedBranch]}
        demoMode={false}
        selectedBranchId={syncedBranch.id}
        onSelect={() => undefined}
        onCheckout={() => undefined}
        onContextMenu={() => undefined}
        onCreate={() => undefined}
      />
    )

    expect(markup).toContain('已同步')
    expect(markup).not.toContain('同步状态未知')
  })
})
