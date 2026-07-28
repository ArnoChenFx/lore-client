import { describe, expect, it } from 'vitest'

import { LatestTaskQueue, settleTasksSequentially, SupersededTaskError } from './latestTaskQueue'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('latest task queue', () => {
  it('runs the active task and only the newest queued task during rapid replacement', async () => {
    const queue = new LatestTaskQueue()
    const active = createDeferred<number>()
    const executed: number[] = []

    const first = queue.run(async () => {
      executed.push(1)
      return active.promise
    })
    const replacements = Array.from({ length: 99 }, (_, index) => {
      const value = index + 2
      return queue.run(async () => {
        executed.push(value)
        return value
      })
    })
    const replacementResults = Promise.allSettled(replacements)

    expect(executed).toEqual([1])
    active.resolve(1)

    await expect(first).resolves.toBe(1)
    const results = await replacementResults
    expect(executed).toEqual([1, 100])
    expect(results.slice(0, -1).every((result) => result.status === 'rejected')).toBe(true)
    expect(
      results
        .slice(0, -1)
        .every((result) => result.status === 'rejected' && result.reason instanceof SupersededTaskError)
    ).toBe(true)
    expect(results.at(-1)).toEqual({ status: 'fulfilled', value: 100 })
  })

  it('drops the queued task when the owner releases the queue', async () => {
    const queue = new LatestTaskQueue()
    const active = createDeferred<number>()
    const first = queue.run(() => active.promise)
    const queued = queue.run(async () => 2)
    const queuedResult = queued.catch((error: unknown) => error)

    queue.dispose()
    active.resolve(1)

    await expect(first).resolves.toBe(1)
    await expect(queuedResult).resolves.toBeInstanceOf(SupersededTaskError)
  })

  it('settles paired binary previews without overlapping their large payloads', async () => {
    let activeTasks = 0
    let maximumActiveTasks = 0
    const task =
      (value: number, reject = false) =>
      async () => {
        activeTasks += 1
        maximumActiveTasks = Math.max(maximumActiveTasks, activeTasks)
        await Promise.resolve()
        activeTasks -= 1
        if (reject) throw new Error(`failed-${value}`)
        return value
      }

    const results = await settleTasksSequentially([task(1), task(2, true)])

    expect(maximumActiveTasks).toBe(1)
    expect(results[0]).toEqual({ status: 'fulfilled', value: 1 })
    expect(results[1]?.status).toBe('rejected')
  })
})
