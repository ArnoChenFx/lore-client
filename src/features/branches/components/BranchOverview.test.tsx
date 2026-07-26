import { describe, expect, it } from 'vitest'

import type { Branch } from '../../../types'
import { activeOverviewBranches } from './BranchOverview'

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
})
