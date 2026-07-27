import { describe, expect, it } from 'vitest'

import {
  getRepositoryRecoveryDelay,
  isRepositoryNotificationDisconnected,
  isRepositoryRefreshNotification,
  shouldAutomaticallyRecoverRepository
} from './useRepositoryRefresh'

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

  it('recognizes notification stream termination separately from data changes', () => {
    const notification = {
      repositoryPath: 'C:/repository',
      event: { tagName: 'notificationUnsubscribed', data: {} }
    }

    expect(isRepositoryNotificationDisconnected(notification)).toBe(true)
    expect(isRepositoryRefreshNotification(notification)).toBe(false)
  })

  it('retries only remote repositories that are currently offline', () => {
    expect(shouldAutomaticallyRecoverRepository('offline')).toBe(true)
    expect(shouldAutomaticallyRecoverRepository('local')).toBe(false)
    expect(shouldAutomaticallyRecoverRepository('unauthorized')).toBe(false)
    expect(shouldAutomaticallyRecoverRepository('online')).toBe(false)
  })

  it('uses jittered exponential backoff with a maximum delay', () => {
    const midpoint = () => 0.5

    expect(getRepositoryRecoveryDelay(0, midpoint)).toBe(1_000)
    expect(getRepositoryRecoveryDelay(1, midpoint)).toBe(2_000)
    expect(getRepositoryRecoveryDelay(4, midpoint)).toBe(16_000)
    expect(getRepositoryRecoveryDelay(20, midpoint)).toBe(30_000)
    expect(getRepositoryRecoveryDelay(0, () => -1)).toBe(800)
    expect(getRepositoryRecoveryDelay(20, () => 2)).toBe(30_000)
  })
})
