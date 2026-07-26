import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'

import i18n from '../../i18n'
import type { Branch } from '../../types'
import { groupSidebarBranches, Sidebar } from './Sidebar'

const archivedBranch: Branch = {
  id: 'local:feature-archive-id',
  name: 'feature/archive-me',
  latest: 'abcdef1234567890',
  archived: true
}

const currentBranch: Branch = {
  id: 'local:main',
  name: 'main',
  latest: '1111111111111111',
  current: true
}

const selectedBranch: Branch = {
  id: 'local:feature',
  name: 'feature',
  latest: '2222222222222222'
}

describe('sidebar Lore tools and archived branches', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US')
  })

  it('places archived entries in a dedicated group', () => {
    const groups = groupSidebarBranches([archivedBranch], '')
    expect(groups.localBranches).toEqual([])
    expect(groups.remoteBranches).toEqual([])
    expect(groups.archivedBranches).toEqual([archivedBranch])
  })

  it('keeps the active branch distinct from the selected branch and tag', () => {
    const html = renderToStaticMarkup(
      <Sidebar
        repository={{
          id: 'repository:demo',
          name: 'demo',
          branch: 'main',
          revision: '1111111111111111',
          path: 'C:\\demo',
          ahead: 0,
          behind: 0,
          online: false,
          color: '#78a4ff',
          conflictCount: 0,
          unresolvedConflictCount: 0
        }}
        branches={[currentBranch, selectedBranch]}
        tags={[
          {
            id: 'tag:release',
            name: 'release',
            branch: 'main',
            revision: '1111111111111111',
            message: 'Release',
            createdAt: 1,
            updatedAt: 1
          }
        ]}
        demoMode={false}
        activeView="history"
        selectedBranchId={selectedBranch.id}
        selectedTagId="tag:release"
        changeCount={0}
        onViewChange={() => undefined}
        onBranchSelect={() => undefined}
        onBranchCheckout={() => undefined}
        onBranchContextMenu={() => undefined}
        onTagSelect={() => undefined}
        onTagLocateRevision={() => undefined}
        onTagContextMenu={() => undefined}
        onOpenOperations={() => undefined}
        onOpenServer={() => undefined}
        onOpenConfiguration={() => undefined}
        onOpenAccounts={() => undefined}
        onOpenRepositoryTools={() => undefined}
      />
    )

    expect(html).toMatch(/class="tree-row tree-row--local is-current "\s+aria-current="true"\s+aria-pressed="false"/)
    expect(html).toMatch(/class="tree-row tree-row--local\s+is-selected"\s+aria-pressed="true"/)
    expect(html).toMatch(/class="tree-row tree-row--tag is-selected"\s+aria-pressed="true"/)
  })
})
