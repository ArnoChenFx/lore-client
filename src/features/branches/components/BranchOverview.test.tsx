import { describe, expect, it } from 'vitest'

import type { Branch } from '../../../types'
import { activeOverviewBranches, groupOverviewBranches } from './BranchOverview'

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
})
