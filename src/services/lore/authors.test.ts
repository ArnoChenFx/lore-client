import { describe, expect, it, vi } from 'bun:test'

import type { Repository } from '../../types'
import { RepositoryAuthorNameResolver, type AuthorNameResolverDependencies } from './authors'

const repository: Repository = {
  id: 'repository-id',
  path: '/work/project',
  name: 'Project',
  branch: 'main',
  revision: 'tip',
  online: true,
  remoteState: 'online',
  remoteUrl: 'lore://server/project',
  serverUrl: 'lore://server',
  color: '#000000',
  ahead: 0,
  behind: 0,
  conflictCount: 0,
  unresolvedConflictCount: 0
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function dependencies(overrides: Partial<AuthorNameResolverDependencies> = {}): AuthorNameResolverDependencies {
  return {
    loadCached: vi.fn(async () => new Map()),
    loadRemote: vi.fn(async () => new Map()),
    loadLocal: vi.fn(async () => new Map()),
    remember: vi.fn(async () => undefined),
    now: () => 1_000,
    ...overrides
  }
}

describe('repository author name enrichment', () => {
  it('publishes disk names while remote lookup is still pending, then updates them from Auth', async () => {
    const remoteStarted = deferred<void>()
    const remote = deferred<ReadonlyMap<string, string>>()
    const service = dependencies({
      loadCached: async () => new Map([['user', 'Cached name']]),
      loadRemote: async () => {
        remoteStarted.resolve()
        return remote.promise
      }
    })
    const resolver = new RepositoryAuthorNameResolver(repository, service)
    const updates: ReadonlyMap<string, string>[] = []
    let finished = false
    const task = resolver
      .hydrate(['user'], (names) => updates.push(names))
      .then(() => {
        finished = true
      })

    await remoteStarted.promise
    expect(updates).toEqual([new Map([['user', 'Cached name']])])
    expect(finished).toBe(false)
    remote.resolve(new Map([['user', 'Current name']]))
    await task

    expect(updates.at(-1)).toEqual(new Map([['user', 'Current name']]))
    expect(service.remember).toHaveBeenCalledWith(repository.id, new Map([['user', 'Current name']]))
  })

  it('deduplicates overlapping batches by identity and publishes only each caller’s candidates', async () => {
    const firstStarted = deferred<void>()
    const secondStarted = deferred<void>()
    const firstRemote = deferred<ReadonlyMap<string, string>>()
    const secondRemote = deferred<ReadonlyMap<string, string>>()
    const service = dependencies({
      loadRemote: vi.fn(async (_path, identities) => {
        if (identities.includes('a')) {
          firstStarted.resolve()
          return firstRemote.promise
        }
        secondStarted.resolve()
        return secondRemote.promise
      })
    })
    const resolver = new RepositoryAuthorNameResolver(repository, service)
    const firstUpdates: ReadonlyMap<string, string>[] = []
    const secondUpdates: ReadonlyMap<string, string>[] = []
    const first = resolver.hydrate(['a', 'b', 'a'], (names) => firstUpdates.push(names))
    await firstStarted.promise
    const second = resolver.hydrate(['b', 'c'], (names) => secondUpdates.push(names))
    await secondStarted.promise

    expect(service.loadRemote).toHaveBeenCalledTimes(2)
    expect(service.loadRemote).toHaveBeenNthCalledWith(1, repository.path, ['a', 'b'])
    expect(service.loadRemote).toHaveBeenNthCalledWith(2, repository.path, ['c'])

    firstRemote.resolve(
      new Map([
        ['a', 'Alice'],
        ['b', 'Bob'],
        ['unrequested', 'Other account']
      ])
    )
    await first
    expect(firstUpdates.at(-1)).toEqual(
      new Map([
        ['a', 'Alice'],
        ['b', 'Bob']
      ])
    )
    expect(secondUpdates.at(-1)).toEqual(new Map([['b', 'Bob']]))
    secondRemote.resolve(new Map([['c', 'Carol']]))
    await second
    expect(secondUpdates.at(-1)).toEqual(
      new Map([
        ['b', 'Bob'],
        ['c', 'Carol']
      ])
    )
  })

  it('splits combined history and branch authors at the native 1,000-identity request limit', async () => {
    const identities = Array.from({ length: 1_001 }, (_, index) => `user-${index}`)
    const cacheBatches: string[][] = []
    const remoteBatches: string[][] = []
    const service = dependencies({
      loadCached: async (_repositoryId, candidates) => {
        cacheBatches.push([...candidates])
        return new Map()
      },
      loadRemote: async (_path, candidates) => {
        remoteBatches.push([...candidates])
        return new Map(candidates.map((identity) => [identity, `Name ${identity}`]))
      }
    })
    const resolver = new RepositoryAuthorNameResolver(repository, service)
    const updates: ReadonlyMap<string, string>[] = []
    await resolver.hydrate(identities, (names) => updates.push(names))

    expect(cacheBatches.map((batch) => batch.length)).toEqual([1_000, 1])
    expect(remoteBatches.map((batch) => batch.length)).toEqual([1_000, 1])
    expect(remoteBatches.flat()).toEqual(identities)
    expect(updates.at(-1)).toEqual(new Map(identities.map((identity) => [identity, `Name ${identity}`])))
  })

  it('reuses fresh names immediately and fetches a renamed account after freshness expires', async () => {
    let now = 1_000
    let name = 'Original name'
    const service = dependencies({
      now: () => now,
      loadCached: async () => new Map([['user', 'Old disk name']]),
      loadRemote: vi.fn(async () => new Map([['user', name]]))
    })
    const resolver = new RepositoryAuthorNameResolver(repository, service)
    await resolver.hydrate(['user'], () => undefined)

    name = 'Renamed account'
    const freshUpdates: ReadonlyMap<string, string>[] = []
    const fresh = resolver.hydrate(['user'], (names) => freshUpdates.push(names))
    expect(freshUpdates).toEqual([new Map([['user', 'Original name']])])
    await fresh
    expect(service.loadRemote).toHaveBeenCalledTimes(1)

    now += 5 * 60_000
    const refreshed: ReadonlyMap<string, string>[] = []
    await resolver.hydrate(['user'], (names) => refreshed.push(names))
    expect(refreshed).toEqual([new Map([['user', 'Original name']]), new Map([['user', 'Renamed account']])])
    expect(service.loadRemote).toHaveBeenCalledTimes(2)
  })

  it('briefly caches unknown identities and retries them instead of querying every history refresh', async () => {
    let now = 1_000
    const service = dependencies({ now: () => now })
    const resolver = new RepositoryAuthorNameResolver(repository, service)
    const update = vi.fn()
    await resolver.hydrate(['free-form identity'], update)
    now += 29_999
    await resolver.hydrate(['free-form identity'], update)
    expect(service.loadRemote).toHaveBeenCalledTimes(1)
    expect(update).not.toHaveBeenCalled()
    now += 1
    await resolver.hydrate(['free-form identity'], update)
    expect(service.loadRemote).toHaveBeenCalledTimes(2)
  })

  it('keeps cached names after Auth failure but retries sooner than a confirmed positive name', async () => {
    let now = 1_000
    const service = dependencies({
      now: () => now,
      loadCached: async () => new Map([['user', 'Cached name']]),
      loadRemote: vi.fn(async () => {
        throw new Error('Remote unavailable')
      }),
      loadLocal: vi.fn(async () => {
        throw new Error('No bound account')
      })
    })
    const resolver = new RepositoryAuthorNameResolver(repository, service)
    const updates: ReadonlyMap<string, string>[] = []
    await resolver.hydrate(['user'], (names) => updates.push(names))
    expect(updates.at(-1)).toEqual(new Map([['user', 'Cached name']]))
    now += 30_000
    await resolver.hydrate(['user'], () => undefined)
    expect(service.loadRemote).toHaveBeenCalledTimes(2)
    expect(service.remember).not.toHaveBeenCalled()
  })

  it('uses disk names without a bound account while offline and never calls remote Auth', async () => {
    const service = dependencies({
      loadCached: async () => new Map([['user', 'Cached Author <cached@example.com>']]),
      loadLocal: async () => {
        throw new Error('No bound local profile')
      }
    })
    const resolver = new RepositoryAuthorNameResolver({ ...repository, online: false }, service)
    const updates: ReadonlyMap<string, string>[] = []
    await resolver.hydrate(['user'], (names) => updates.push(names))

    expect(updates).toEqual([new Map([['user', 'Cached Author <cached@example.com>']])])
    expect(service.loadRemote).not.toHaveBeenCalled()
  })

  it('enriches an offline identity from the bound local profile without assigning it to other users', async () => {
    const service = dependencies({
      loadLocal: async () =>
        new Map([
          ['bound-user', 'Local Author'],
          ['unrequested-user', 'Other account']
        ])
    })
    const resolver = new RepositoryAuthorNameResolver({ ...repository, online: false }, service)
    const updates: ReadonlyMap<string, string>[] = []
    await resolver.hydrate(['bound-user', 'historical-user'], (names) => updates.push(names))

    expect(updates).toEqual([new Map([['bound-user', 'Local Author']])])
    expect(service.remember).toHaveBeenCalledWith(repository.id, new Map([['bound-user', 'Local Author']]))
    expect(service.loadRemote).not.toHaveBeenCalled()
  })

  it('discards late results after disposal without callbacks, cache writes, or new lookups', async () => {
    const remoteStarted = deferred<void>()
    const remote = deferred<ReadonlyMap<string, string>>()
    const service = dependencies({
      loadRemote: vi.fn(async () => {
        remoteStarted.resolve()
        return remote.promise
      })
    })
    const resolver = new RepositoryAuthorNameResolver(repository, service)
    const update = vi.fn()
    const task = resolver.hydrate(['user'], update)
    await remoteStarted.promise
    resolver.dispose()
    remote.resolve(new Map([['user', 'Late name']]))
    await task
    await resolver.hydrate(['user'], update)

    expect(update).not.toHaveBeenCalled()
    expect(service.remember).not.toHaveBeenCalled()
    expect(service.loadRemote).toHaveBeenCalledTimes(1)
  })

  it('does not start Auth work when the owner closes during an optional cache read', async () => {
    const cacheStarted = deferred<void>()
    const cache = deferred<ReadonlyMap<string, string>>()
    const service = dependencies({
      loadCached: async () => {
        cacheStarted.resolve()
        return cache.promise
      }
    })
    const resolver = new RepositoryAuthorNameResolver(repository, service)
    const update = vi.fn()
    const task = resolver.hydrate(['user'], update)
    await cacheStarted.promise
    resolver.dispose()
    cache.resolve(new Map([['user', 'Late cache']]))
    await task

    expect(update).not.toHaveBeenCalled()
    expect(service.loadRemote).not.toHaveBeenCalled()
    expect(service.loadLocal).not.toHaveBeenCalled()
    expect(service.remember).not.toHaveBeenCalled()
  })

  it('releases an aborted observer immediately while a new observer reuses its pending Auth request', async () => {
    const remoteStarted = deferred<void>()
    const remote = deferred<ReadonlyMap<string, string>>()
    const service = dependencies({
      loadRemote: vi.fn(async () => {
        remoteStarted.resolve()
        return remote.promise
      })
    })
    const resolver = new RepositoryAuthorNameResolver(repository, service)
    const oldUpdate = vi.fn()
    const newUpdate = vi.fn()
    const controller = new AbortController()
    const oldTask = resolver.hydrate(['user'], oldUpdate, controller.signal)
    await remoteStarted.promise
    controller.abort()
    await oldTask
    const newTask = resolver.hydrate(['user'], newUpdate)
    expect(service.loadRemote).toHaveBeenCalledTimes(1)

    remote.resolve(new Map([['user', 'Current name']]))
    await newTask
    expect(oldUpdate).not.toHaveBeenCalled()
    expect(newUpdate).toHaveBeenCalledWith(new Map([['user', 'Current name']]))
    expect(service.loadRemote).toHaveBeenCalledTimes(1)
  })

  it('does not let a slow optional cache write keep a fresh lookup in flight forever', async () => {
    let now = 1_000
    const write = deferred<void>()
    const service = dependencies({
      now: () => now,
      loadRemote: vi.fn(async () => new Map([['user', 'Name']])),
      remember: () => write.promise
    })
    const resolver = new RepositoryAuthorNameResolver(repository, service)
    await resolver.hydrate(['user'], () => undefined)
    now += 5 * 60_000
    await resolver.hydrate(['user'], () => undefined)
    expect(service.loadRemote).toHaveBeenCalledTimes(2)
    write.resolve()
  })

  it('scopes persistent keys by repository and authentication context with bounded opaque identifiers', async () => {
    const keys: string[] = []
    const service = dependencies({
      loadCached: async (key) => {
        keys.push(key)
        return new Map()
      }
    })
    const scope = JSON.stringify({ path: '/long/'.repeat(200), authUrl: 'https://auth', userId: 'one' })
    const sameA = new RepositoryAuthorNameResolver(repository, service, scope)
    const sameB = new RepositoryAuthorNameResolver(repository, service, scope)
    const different = new RepositoryAuthorNameResolver(repository, service, `${scope}-other-account`)

    await sameA.hydrate(['user'], () => undefined)
    await sameB.hydrate(['user'], () => undefined)
    await different.hydrate(['user'], () => undefined)
    expect(keys[0]).toMatch(/^author-scope-v1:[a-f0-9]{64}$/)
    expect(keys[0]).toBe(keys[1])
    expect(keys[2]).not.toBe(keys[0])
    expect(keys).not.toContain(repository.id)
  })

  it('disables persistence when scoped hashing fails instead of reading an unscoped cache', async () => {
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest').mockRejectedValue(new Error('Crypto unavailable'))
    const service = dependencies({ loadRemote: async () => new Map([['user', 'Remote name']]) })
    try {
      const resolver = new RepositoryAuthorNameResolver(repository, service, 'account-scope')
      const update = vi.fn()
      await resolver.hydrate(['user'], update)
      expect(update).toHaveBeenCalledWith(new Map([['user', 'Remote name']]))
      expect(service.loadCached).not.toHaveBeenCalled()
      expect(service.remember).not.toHaveBeenCalled()
    } finally {
      digest.mockRestore()
    }
  })

  it('rejects unsafe candidates and unsolicited or malformed display names', async () => {
    const service = dependencies({
      loadRemote: vi.fn(
        async () =>
          new Map([
            ['user', 'Valid name'],
            ['same-name', 'same-name'],
            ['bad-name', 'Name\nwith control'],
            ['unrequested', 'Unrelated account']
          ])
      )
    })
    const resolver = new RepositoryAuthorNameResolver(repository, service)
    const update = vi.fn()
    await resolver.hydrate(['user', 'same-name', 'bad-name', '', '<unknown>', 'bad\nid', 'a'.repeat(513)], update)

    expect(service.loadRemote).toHaveBeenCalledWith(repository.path, ['user', 'same-name', 'bad-name'])
    expect(update).toHaveBeenCalledWith(new Map([['user', 'Valid name']]))
    expect(service.remember).toHaveBeenCalledWith(repository.id, new Map([['user', 'Valid name']]))
  })
})
