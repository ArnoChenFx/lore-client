import { describe, expect, it } from 'vitest'

import { shouldAnnounceOperationSuccess } from './toastPolicy'

describe('high-frequency operation success toast policy', () => {
  it.each([
    'stageFiles',
    'unstageFiles',
    'stageAll',
    'unstageAll',
    'checkOutRevision',
    'switchBranch',
    'attachRemoteBranch',
    'acquireCollaborativeLock',
    'releaseCollaborativeLock'
  ])('%s stays silent after success', (operationKey) => {
    expect(shouldAnnounceOperationSuccess(operationKey)).toBe(false)
  })

  it('allows success toasts for failure-sensitive or low-frequency operations', () => {
    expect(shouldAnnounceOperationSuccess('createRevision')).toBe(true)
    expect(shouldAnnounceOperationSuccess('mergeBranch')).toBe(true)
  })
})
