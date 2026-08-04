import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'

import i18n from '../../i18n'
import {
  buildSidebarBranchTree,
  buildSidebarTagTree,
  sortTagsByEnglishName,
  type SidebarPathTreeNode
} from '../../shared/lib'
import type { Branch, LoreTag } from '../../types'
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

function describeTree<T>(nodes: SidebarPathTreeNode<T>[]): unknown[] {
  return nodes.map((node) =>
    node.kind === 'folder'
      ? {
          folder: node.name,
          children: describeTree(node.children)
        }
      : node.name
  )
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

  it('sorts local remote and archived branches by fixed English names', () => {
    const groups = groupSidebarBranches(
      [
        { id: 'local:zulu', name: 'Zulu' },
        { id: 'local:alpha', name: 'alpha' },
        { id: 'remote:zulu', name: 'zulu', remote: true },
        { id: 'remote:beta', name: 'Beta', remote: true },
        { id: 'archived:zulu', name: 'zulu-old', archived: true },
        { id: 'archived:alpha', name: 'Alpha-old', archived: true }
      ],
      ''
    )

    expect(groups.localBranches.map((branch) => branch.name)).toEqual(['alpha', 'Zulu'])
    expect(groups.remoteBranches.map((branch) => branch.name)).toEqual(['Beta', 'zulu'])
    expect(groups.archivedBranches.map((branch) => branch.name)).toEqual(['Alpha-old', 'zulu-old'])
  })

  it('builds a folder-first recursively sorted branch tree', () => {
    const tree = buildSidebarBranchTree([
      { id: 'local:zulu', name: 'zulu' },
      { id: 'local:feat-zulu', name: 'feat/zulu' },
      { id: 'local:alpha', name: 'Alpha' },
      { id: 'local:bug-fix', name: 'bug/fix' },
      { id: 'local:feat-alpha', name: 'feat/Alpha' },
      { id: 'local:feat-deep', name: 'feat/api/Beta' }
    ])

    expect(describeTree(tree)).toEqual([
      { folder: 'bug', children: ['fix'] },
      { folder: 'feat', children: [{ folder: 'api', children: ['Beta'] }, 'Alpha', 'zulu'] },
      'Alpha',
      'zulu'
    ])
  })

  it('keeps a branch leaf beside a same-name folder and preserves malformed slash names', () => {
    const tree = buildSidebarBranchTree([
      { id: 'local:feat', name: 'feat' },
      { id: 'local:feat-child', name: 'feat/axx' },
      { id: 'local:malformed', name: 'odd//name' }
    ])

    expect(describeTree(tree)).toEqual([{ folder: 'feat', children: ['axx'] }, 'feat', 'odd//name'])
  })

  it('sorts tags by fixed English names without mutating the source array', () => {
    const tags: LoreTag[] = [
      {
        id: 'tag:zulu',
        name: 'Zulu',
        branch: 'main',
        revision: '1',
        message: '',
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'tag:alpha',
        name: 'alpha',
        branch: 'main',
        revision: '2',
        message: '',
        createdAt: 2,
        updatedAt: 2
      }
    ]

    expect(sortTagsByEnglishName(tags).map((tag) => tag.name)).toEqual(['alpha', 'Zulu'])
    expect(tags.map((tag) => tag.name)).toEqual(['Zulu', 'alpha'])
  })

  it('builds a folder-first recursively sorted tag tree', () => {
    const createTag = (id: string, name: string): LoreTag => ({
      id,
      name,
      branch: 'main',
      revision: id,
      message: '',
      createdAt: 1,
      updatedAt: 1
    })
    const tree = buildSidebarTagTree([
      createTag('tag:release-zulu', 'release/zulu'),
      createTag('tag:preview-beta', 'preview/Beta'),
      createTag('tag:root-alpha', 'Alpha'),
      createTag('tag:release-alpha', 'release/alpha')
    ])

    expect(describeTree(tree)).toEqual([
      { folder: 'preview', children: ['Beta'] },
      { folder: 'release', children: ['alpha', 'zulu'] },
      'Alpha'
    ])
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
          remoteState: 'local',
          color: '#78a4ff',
          conflictCount: 0,
          unresolvedConflictCount: 0
        }}
        branches={[currentBranch, selectedBranch]}
        tags={[
          {
            id: 'tag:release',
            name: 'release/v1',
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
        repositoryIcon="gamepad"
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
        onRepositoryIconChange={() => undefined}
      />
    )

    expect(html).toMatch(
      /class="tree-row tree-row--local tree-row--path-node tree-row--branch-node is-current"[^>]*aria-current="true"[^>]*aria-pressed="false"/
    )
    expect(html).toMatch(
      /class="tree-row tree-row--local tree-row--path-node tree-row--branch-node is-selected"[^>]*aria-pressed="true"/
    )
    expect(html).toMatch(
      /class="tree-row tree-row--tag tree-row--path-node is-selected"[^>]*aria-label="release\/v1"[^>]*aria-pressed="true"/
    )
    expect(html).toContain('<span>v1</span>')
    expect(html).toContain('aria-label="Change workspace icon"')
  })
})
