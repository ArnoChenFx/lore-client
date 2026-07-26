import { describe, expect, it } from 'vitest'

import { isRepositoryRefreshNotification } from './useRepositoryRefresh'

describe('repository refresh controller', () => {
  it('refreshes only for notifications that can change the repository snapshot', () => {
    expect(
      isRepositoryRefreshNotification({
        repositoryPath: 'C:/repository',
        event: { tagName: 'notificationBranchPushed', data: {} }
      })
    ).toBe(true)
    expect(
      isRepositoryRefreshNotification({
        repositoryPath: 'C:/repository',
        event: { tagName: 'notificationResourceLocked', data: {} }
      })
    ).toBe(true)
    expect(
      isRepositoryRefreshNotification({
        repositoryPath: 'C:/repository',
        event: { tagName: 'unrelatedProgress', data: {} }
      })
    ).toBe(false)
  })
})
