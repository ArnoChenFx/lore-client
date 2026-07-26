import { describe, expect, it } from 'vitest'

import { isBranchAlreadyAtWorkspaceRevision } from './branchCheckout'

describe('Branch checkout state', () => {
  it('does not skip checkout when the current Branch workspace is on an older Revision', () => {
    expect(
      isBranchAlreadyAtWorkspaceRevision(
        { name: 'main', current: true, latest: 'main-tip' },
        { branch: 'main', revision: 'old-head' }
      )
    ).toBe(false)
  })

  it('skips checkout only when Branch identity and exact latest Revision both match', () => {
    expect(
      isBranchAlreadyAtWorkspaceRevision(
        { name: 'main', current: true, latest: 'main-tip' },
        { branch: 'main', revision: 'main-tip' }
      )
    ).toBe(true)
  })
})
