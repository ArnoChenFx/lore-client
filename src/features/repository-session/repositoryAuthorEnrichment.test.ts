import { describe, expect, it } from 'bun:test'

import { RepositoryAuthorNameResolver } from '../../services/lore'
import type { Repository, RepositoryAuthAccountBinding, RepositorySnapshot, Revision } from '../../types'
import { repositoryAuthorIdentities, updateRepositoryAuthorNames } from './repositoryAuthorNames'
import { RepositorySessionRequests } from './repositorySessionRequests'
import { RepositoryAuthorEnrichment } from './useRepositoryAuthorEnrichment'

function revision(id: string, authorIdentity = 'user-42'): Revision {
  return {
    id,
    shortId: id,
    title: id,
    revisionNumber: 1,
    committedAt: null,
    authorIdentity,
    author: authorIdentity,
    initials: authorIdentity.slice(0, 1).toLocaleUpperCase(),
    branchPointers: [],
    parentCount: 0,
    parentIds: [],
    filesChanged: 0,
    additions: 0,
    deletions: 0
  }
}

function snapshot(path = '/workspace/A'): RepositorySnapshot {
  return {
    repository: {
      id: 'shared-repository',
      name: path,
      path,
      branch: 'main',
      revision: 'tip',
      remoteUrl: 'lore://example.com/project',
      serverUrl: 'lore://example.com',
      ahead: 0,
      behind: 0,
      online: true,
      remoteState: 'online',
      color: '#000000',
      conflictCount: 0,
      unresolvedConflictCount: 0
    },
    revisions: [revision('tip')],
    branches: [
      { id: 'main', name: 'main', current: true, remote: false, creatorIdentity: 'user-42', author: 'user-42' }
    ],
    changes: [],
    tags: [],
    conflictSession: null,
    loadedAt: 'original-load'
  }
}

class DeferredAuthorResolver {
  readonly queries: string[][] = []
  readonly callbacks: Array<(names: ReadonlyMap<string, string>) => void> = []
  private readonly completions: Array<() => void> = []
  disposed = false

  constructor(
    readonly repository: Repository,
    readonly cacheScope: string
  ) {}

  hydrate(identities: readonly string[], onNames: (names: ReadonlyMap<string, string>) => void): Promise<void> {
    this.queries.push([...identities])
    this.callbacks.push(onNames)
    return new Promise((resolve) => this.completions.push(resolve))
  }

  /** Deliberately deliver after disposal: the session owner must also reject stale native work. */
  complete(names: ReadonlyMap<string, string>): void {
    for (const callback of this.callbacks) callback(names)
    for (const complete of this.completions) complete()
  }

  dispose(): void {
    this.disposed = true
  }
}

function fixture(initial = [snapshot()]) {
  let snapshots = initial
  const requests = new RepositorySessionRequests(initial.map((item) => item.repository.path))
  const resolvers: DeferredAuthorResolver[] = []
  const owner = new RepositoryAuthorEnrichment(
    requests,
    (request, names) => {
      if (!requests.isCurrent(request)) return false
      const next = updateRepositoryAuthorNames(snapshots, request.path, names)
      const changed = next !== snapshots
      snapshots = next
      return changed
    },
    (repository, scope) => {
      const resolver = new DeferredAuthorResolver(repository, scope)
      resolvers.push(resolver)
      return resolver
    }
  )
  return {
    owner,
    requests,
    resolvers,
    snapshots: () => snapshots,
    replace: (next: RepositorySnapshot[]) => {
      snapshots = next
    },
    reconcile: (authVersion = 0, bindings: RepositoryAuthAccountBinding[] = []) =>
      owner.reconcile(snapshots, authVersion, bindings)
  }
}

describe('repository author enrichment lifecycle', () => {
  it('does not consume the snapshot/history request slots and rejects a lookup when authentication refresh starts', () => {
    const requests = new RepositorySessionRequests(['/workspace/A'])
    const scan = requests.beginRead('/workspace/A', 'snapshot')!
    const history = requests.beginRead('/workspace/A', 'history')!
    const authors = requests.beginAuthorLookup('/workspace/A')!
    expect(requests.isCurrent(scan)).toBe(true)
    expect(requests.isCurrent(history)).toBe(true)
    expect(requests.isCurrent(authors)).toBe(true)
    requests.beginRead('/workspace/A', 'snapshot')
    expect(requests.isCurrent(authors)).toBe(false)
  })

  it('never resurrects a closed tab or patches a reopened session from its predecessor', () => {
    const f = fixture()
    f.reconcile()
    const old = f.resolvers[0]
    f.requests.close('/workspace/A')
    f.replace([])
    old.complete(new Map([['user-42', 'Old name']]))
    expect(f.snapshots()).toEqual([])

    f.requests.beginOpen('/workspace/A')
    f.replace([snapshot()])
    f.reconcile()
    expect(old.disposed).toBe(true)
    old.complete(new Map([['user-42', 'Still old']]))
    expect(f.snapshots()[0].revisions[0].author).toBe('user-42')
    f.resolvers[1].complete(new Map([['user-42', 'Fresh name']]))
    expect(f.snapshots()[0].revisions[0].author).toBe('Fresh name')
  })

  it('does not reattach to pre-authentication work while native contexts are changing', () => {
    const f = fixture()
    f.reconcile()
    const old = f.resolvers[0]
    const resume = f.requests.pauseAuthorLookupsForAuthentication('/workspace/A')
    f.requests.beginRead('/workspace/A', 'snapshot')
    // A clock tick or another tab update can reconcile before authStateVersion advances.
    f.reconcile()
    expect(f.requests.beginAuthorLookup('/workspace/A')).toBeNull()
    expect(old.disposed).toBe(true)
    old.complete(new Map([['user-42', 'Old authentication']]))
    expect(f.snapshots()[0].revisions[0].author).toBe('user-42')
    resume()
    f.reconcile()
    expect(f.resolvers).toHaveLength(2)
    old.complete(new Map([['user-42', 'Still old authentication']]))
    expect(f.snapshots()[0].revisions[0].author).toBe('user-42')
    f.resolvers[1].complete(new Map([['user-42', 'New authentication']]))
    expect(f.snapshots()[0].revisions[0].author).toBe('New authentication')
  })

  it('keeps author lookups paused until every overlapping authentication refresh finishes', () => {
    const requests = new RepositorySessionRequests(['/workspace/A'])
    const first = requests.pauseAuthorLookupsForAuthentication('/workspace/A')
    const second = requests.pauseAuthorLookupsForAuthentication('/workspace/A')
    first()
    first()
    expect(requests.beginAuthorLookup('/workspace/A')).toBeNull()
    second()
    expect(requests.beginAuthorLookup('/workspace/A')).not.toBeNull()
  })

  it.each(['close-and-reopen', 'reopen', 'replace-session'] as const)(
    'keeps native authentication pauses across %s and rejects the old deferred result',
    async (action) => {
      let current = [snapshot()]
      const requests = new RepositorySessionRequests(['/workspace/A'])
      let finishOldRemote!: (names: ReadonlyMap<string, string>) => void
      const oldRemote = new Promise<ReadonlyMap<string, string>>((resolve) => {
        finishOldRemote = resolve
      })
      let markStarted!: () => void
      const started = new Promise<void>((resolve) => {
        markStarted = resolve
      })
      let markDisplayed!: () => void
      const displayed = new Promise<void>((resolve) => {
        markDisplayed = resolve
      })
      let resolverCount = 0
      let remoteCalls = 0
      const owner = new RepositoryAuthorEnrichment(
        requests,
        (request, names) => {
          if (!requests.isCurrent(request)) return false
          const next = updateRepositoryAuthorNames(current, request.path, names)
          const changed = current !== next
          current = next
          if (current[0].revisions[0].author === 'New authentication') markDisplayed()
          return changed
        },
        (repository, scope) => {
          resolverCount += 1
          return new RepositoryAuthorNameResolver(repository, scope, {
            loadCached: async () => new Map(),
            loadRemote: async () => {
              remoteCalls += 1
              if (remoteCalls === 1) {
                markStarted()
                return oldRemote
              }
              return new Map([['user-42', 'New authentication']])
            },
            remember: async () => undefined
          })
        }
      )
      try {
        owner.reconcile(current, 0, [])
        await started
        const first = requests.pauseAuthorLookupsForAuthentication('/workspace/A')
        if (action === 'close-and-reopen') requests.close('/workspace/A')
        if (action === 'replace-session') {
          requests.retain([])
          requests.retain(['/workspace/A'])
        } else {
          requests.beginOpen('/workspace/A')
        }
        current = [{ ...snapshot(), revisions: [revision('reopened-history')] }]
        expect(requests.beginAuthorLookup('/workspace/A')).toBeNull()
        const second = requests.pauseAuthorLookupsForAuthentication('/workspace/A')
        owner.reconcile(current, 0, [])
        finishOldRemote(new Map([['user-42', 'Old authentication']]))
        first()
        first()
        owner.reconcile(current, 0, [])
        expect(requests.beginAuthorLookup('/workspace/A')).toBeNull()
        expect(resolverCount).toBe(1)
        expect(current[0].revisions[0].author).toBe('user-42')
        second()
        owner.reconcile(current, 0, [])
        await displayed
        expect(resolverCount).toBe(2)
        expect(remoteCalls).toBe(2)
        expect(current[0].revisions[0]).toMatchObject({
          id: 'reopened-history',
          author: 'New authentication'
        })
      } finally {
        owner.dispose()
      }
    }
  )

  it('retains an authentication pause started from a stale snapshot before the path is reopened', () => {
    const requests = new RepositorySessionRequests([])
    const resume = requests.pauseAuthorLookupsForAuthentication('/workspace/A')
    requests.beginOpen('/workspace/A')
    expect(requests.beginAuthorLookup('/workspace/A')).toBeNull()
    resume()
    const author = requests.beginAuthorLookup('/workspace/A')!
    expect(requests.isCurrent(author)).toBe(true)
    const finishNext = requests.pauseAuthorLookupsForAuthentication('/workspace/A')
    expect(requests.isCurrent(author)).toBe(false)
    finishNext()
    expect(requests.isCurrent(author)).toBe(false)
  })

  it('rejects pre-mutation names and preserves the new snapshot when the lookup finishes last', () => {
    const f = fixture()
    f.reconcile()
    const mutation = f.requests.beginMutation('/workspace/A')!
    f.resolvers[0].complete(new Map([['user-42', 'Obsolete name']]))
    expect(f.snapshots()[0].revisions[0].author).toBe('user-42')
    const after = { ...snapshot(), revisions: [revision('after-mutation')], loadedAt: 'after-load' }
    f.replace([after])
    f.requests.finishMutation(mutation)
    f.reconcile()
    f.resolvers[0].complete(new Map([['user-42', 'Late name']]))
    expect(f.snapshots()[0]).toBe(after)
    f.resolvers[1].complete(new Map([['user-42', 'New name <new@example.com>']]))
    expect(f.snapshots()[0].revisions[0]).toMatchObject({
      id: 'after-mutation',
      authorIdentity: 'user-42',
      author: 'New name',
      authorEmail: 'new@example.com'
    })
    expect(f.snapshots()[0].loadedAt).toBe('after-load')
  })

  it('patches current history by raw identity and starts hydration for identities in a newer history query', () => {
    const f = fixture()
    f.reconcile()
    const newer = {
      ...snapshot(),
      revisions: [revision('filtered', 'user-42'), revision('new-author', 'user-84')],
      loadedAt: 'newer-status'
    }
    f.replace([newer])
    f.reconcile()
    expect(f.resolvers).toHaveLength(1)
    expect(f.resolvers[0].queries).toEqual([['user-42'], ['user-42', 'user-84']])
    f.resolvers[0].complete(new Map([['user-42', 'Author']]))
    const current = f.snapshots()[0]
    expect(current.revisions.map((item) => item.id)).toEqual(['filtered', 'new-author'])
    expect(current.revisions[0].author).toBe('Author')
    expect(current.revisions[1].author).toBe('user-84')
    expect(current.repository).toBe(newer.repository)
    expect(current.changes).toBe(newer.changes)
    expect(current.loadedAt).toBe('newer-status')
  })

  it('reuses pending names after a snapshot ticket changes and patches only the currently visible history', async () => {
    let current = [snapshot()]
    const requests = new RepositorySessionRequests(['/workspace/A'])
    let finishRemote!: (names: ReadonlyMap<string, string>) => void
    const remote = new Promise<ReadonlyMap<string, string>>((resolve) => {
      finishRemote = resolve
    })
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let markDisplayed!: () => void
    const displayed = new Promise<void>((resolve) => {
      markDisplayed = resolve
    })
    let remoteCalls = 0
    let resolverCount = 0
    const owner = new RepositoryAuthorEnrichment(
      requests,
      (request, names) => {
        if (!requests.isCurrent(request)) return false
        const next = updateRepositoryAuthorNames(current, request.path, names)
        const changed = current !== next
        current = next
        if (current[0].revisions[0].author === 'Current name') markDisplayed()
        return changed
      },
      (repository, scope) => {
        resolverCount += 1
        return new RepositoryAuthorNameResolver(repository, scope, {
          loadCached: async () => new Map(),
          loadRemote: async () => {
            remoteCalls += 1
            markStarted()
            return remote
          },
          remember: async () => undefined
        })
      }
    )
    try {
      owner.reconcile(current, 0, [])
      await started
      requests.beginRead('/workspace/A', 'snapshot')
      const newer = { ...snapshot(), revisions: [revision('new-history')], loadedAt: 'fresh-status' }
      current = [newer]
      owner.reconcile(current, 0, [])
      finishRemote(new Map([['user-42', 'Current name']]))
      await displayed
      expect(resolverCount).toBe(1)
      expect(remoteCalls).toBe(1)
      expect(current[0].revisions.map((item) => item.id)).toEqual(['new-history'])
      expect(current[0].revisions[0].author).toBe('Current name')
      expect(current[0].repository).toBe(newer.repository)
      expect(current[0].loadedAt).toBe('fresh-status')
    } finally {
      owner.dispose()
    }
  })

  it.each(['authVersion', 'account', 'remote'] as const)('discards names from the previous %s scope', (change) => {
    const f = fixture()
    f.reconcile()
    const previous = f.resolvers[0]
    previous.complete(new Map([['user-42', 'Previous scope']]))
    expect(f.snapshots()[0].branches[0].author).toBe('Previous scope')

    if (change === 'remote') {
      f.replace([
        {
          ...f.snapshots()[0],
          repository: { ...f.snapshots()[0].repository, remoteUrl: 'lore://different.example/project' }
        }
      ])
    }
    const binding = { repositoryPath: '/workspace/A', authUrl: 'https://auth.example', userId: 'new-account' }
    f.reconcile(change === 'authVersion' ? 1 : 0, change === 'account' ? [binding] : [])
    expect(previous.disposed).toBe(true)
    expect(f.snapshots()[0].revisions[0].author).toBe('user-42')
    previous.complete(new Map([['user-42', 'Late old scope']]))
    expect(f.snapshots()[0].revisions[0].author).toBe('user-42')
    f.resolvers[1].complete(new Map([['user-42', 'Current scope']]))
    expect(f.snapshots()[0].branches[0].author).toBe('Current scope')
    if (change !== 'authVersion') {
      expect(f.resolvers[1].cacheScope).not.toBe(previous.cacheScope)
    }
  })

  it('isolates clones sharing a Lore repository ID and disposes all work on owner unmount', () => {
    const f = fixture([snapshot('/workspace/A'), snapshot('/workspace/a')])
    f.reconcile()
    expect(f.resolvers).toHaveLength(2)
    expect(f.resolvers[0].cacheScope).not.toBe(f.resolvers[1].cacheScope)
    f.resolvers[0].complete(new Map([['user-42', 'First clone']]))
    expect(f.snapshots()[1].revisions[0].author).toBe('user-42')
    f.owner.dispose()
    f.resolvers[1].complete(new Map([['user-42', 'Closed owner']]))
    expect(f.snapshots()[1].revisions[0].author).toBe('user-42')
    expect(f.resolvers.every((resolver) => resolver.disposed)).toBe(true)
  })

  it('keeps historical identities and returns the same snapshot reference for duplicate display updates', () => {
    const original = snapshot()
    const before = [original]
    expect(repositoryAuthorIdentities(original)).toEqual(['user-42'])
    const names = new Map([['user-42', 'Artist <artist@example.com>']])
    const updated = updateRepositoryAuthorNames(before, '/workspace/A', names)
    expect(updated[0].revisions[0]).toMatchObject({
      authorIdentity: 'user-42',
      author: 'Artist',
      authorEmail: 'artist@example.com',
      initials: 'A'
    })
    expect(updated[0].branches[0].creatorIdentity).toBe('user-42')
    expect(updateRepositoryAuthorNames(updated, '/workspace/A', names)).toBe(updated)
    expect(updateRepositoryAuthorNames(updated, '/workspace/A', new Map([['unrelated', 'Ignored']]))).toBe(updated)
  })
})
