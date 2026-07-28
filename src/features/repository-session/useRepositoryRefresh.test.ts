import { describe, expect, it } from 'vitest'

import {
  REPOSITORY_NOTIFICATION_STABLE_DELAY_MS,
  getRepositoryRecoveryDelay,
  isRepositoryNotificationDisconnected,
  isRepositoryRefreshNotification,
  RepositoryNotificationConnectionQueue,
  shouldAutomaticallyRecoverRepository
} from './useRepositoryRefresh'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('repository refresh controller', () => {
  it('waits for a stable repository before opening real-time notifications', () => {
    expect(REPOSITORY_NOTIFICATION_STABLE_DELAY_MS).toBe(3_000)
  })

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

  it('connects only the active and latest repository notification intents', async () => {
    const queue = new RepositoryNotificationConnectionQueue()
    const active = createDeferred<string>()
    const connectedRepositories: string[] = []

    const first = queue.connect(async () => {
      connectedRepositories.push('repository-1')
      return active.promise
    })
    const replacements = Array.from({ length: 99 }, (_, index) => {
      const repository = `repository-${index + 2}`
      return queue.connect(async () => {
        connectedRepositories.push(repository)
        return repository
      })
    })
    const replacementResults = Promise.allSettled(replacements)

    expect(connectedRepositories).toEqual(['repository-1'])
    active.resolve('repository-1')

    await expect(first).resolves.toBe('repository-1')
    const results = await replacementResults
    expect(connectedRepositories).toEqual(['repository-1', 'repository-100'])
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(98)
    expect(results.at(-1)).toEqual({ status: 'fulfilled', value: 'repository-100' })
  })
})
