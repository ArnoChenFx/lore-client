import { afterAll, describe, expect, it, vi } from 'bun:test'

import type { RemoteRepository, RepositorySnapshot, Revision } from '../../types'

interface HookState {
  cursor: number
  values: unknown[]
  effects?: (() => void)[]
}
let currentHooks: HookState
const reactActual = { ...(await import('react')) }
afterAll(() => vi.mock('react', () => reactActual))
vi.mock('react', () => ({
  ...reactActual,
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
  useEffect: (effect: () => void | (() => void), dependencies?: readonly unknown[]) => {
    const hooks = currentHooks
    const index = hooks.cursor++
    const previous = hooks.values[index] as { dependencies?: readonly unknown[]; cleanup?: () => void } | undefined
    if (!hooks.effects) {
      hooks.values[index] = { dependencies }
      return
    }
    if (
      dependencies &&
      previous?.dependencies &&
      dependencies.length === previous.dependencies.length &&
      dependencies.every((value, index) => Object.is(value, previous.dependencies![index]))
    )
      return
    hooks.effects.push(() => {
      previous?.cleanup?.()
      hooks.values[index] = { dependencies, cleanup: effect() }
    })
  },
  useRef: <T>(initial: T) => {
    const hooks = currentHooks
    const index = hooks.cursor++
    if (hooks.values.length <= index) hooks.values[index] = { current: initial }
    return hooks.values[index] as { current: T }
  },
  useState: <T>(initial: T | (() => T)) => {
    const hooks = currentHooks
    const index = hooks.cursor++
    if (hooks.values.length <= index) {
      hooks.values[index] = typeof initial === 'function' ? (initial as () => T)() : initial
    }
    return [
      hooks.values[index] as T,
      (next: T | ((current: T) => T)) => {
        hooks.values[index] = typeof next === 'function' ? (next as (value: T) => T)(hooks.values[index] as T) : next
      }
    ] as const
  }
}))

const { useRepositorySession } = await import('./useRepositorySession')
const { useRepositoryRefresh } = await import('./useRepositoryRefresh')
const { useRepositoryEntryController } = await import('./useRepositoryEntryController')
const { useRepositorySessionLifecycle } = await import('./useRepositorySessionLifecycle')

/** Run the real event callbacks; rendering is explicit to exercise batched events. */
function harness<T>(hook: () => T, withEffects = false) {
  const hooks: HookState = { cursor: 0, values: [], effects: withEffects ? [] : undefined }
  const render = () => {
    currentHooks = hooks
    hooks.cursor = 0
    return hook()
  }
  render.flushEffects = () => {
    for (const effect of hooks.effects?.splice(0) ?? []) effect()
  }
  return render
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

function snapshot(path = '/workspace/A', revision = 'head-1'): RepositorySnapshot {
  return {
    repository: {
      id: 'shared-lore-id',
      name: path,
      path,
      branch: 'main',
      revision,
      ahead: 0,
      behind: 0,
      online: false,
      remoteState: 'local',
      color: '#000000',
      conflictCount: 0,
      unresolvedConflictCount: 0
    },
    revisions: [],
    branches: [],
    changes: [],
    tags: [],
    conflictSession: null,
    loadedAt: '2026-10-20T00:00:00.000Z'
  }
}

function revision(id: string): Revision {
  return {
    id,
    shortId: id,
    title: id,
    revisionNumber: 1,
    author: 'Author',
    initials: 'A',
    committedAt: null,
    branchPointers: [],
    parentCount: 0,
    parentIds: [],
    filesChanged: 0,
    additions: 0,
    deletions: 0
  }
}

function refreshFixture() {
  const original = snapshot()
  const renderSession = harness(() => useRepositorySession([original]))
  const session = renderSession()
  const loadSnapshot = vi.fn<() => Promise<RepositorySnapshot>>()
  const onRefreshError = vi.fn()
  const renderRefresh = harness(() =>
    useRepositoryRefresh({
      enabled: true,
      repositoryPath: original.repository.path,
      remoteState: 'local',
      requests: session.requests,
      applySnapshot: session.applySnapshot,
      loadSnapshot,
      onRefreshError
    })
  )
  return { original, session, renderSession, renderRefresh, loadSnapshot, onRefreshError }
}

describe('repository publication races', () => {
  it('does not resurrect a closed tab when its scan completes', async () => {
    const fixture = refreshFixture()
    const scan = deferred<RepositorySnapshot>()
    fixture.loadSnapshot.mockReturnValueOnce(scan.promise)
    const pending = fixture.renderRefresh().refreshActiveRepositorySnapshot()
    fixture.session.removeRepositorySnapshot(fixture.original.repository.path)
    scan.resolve(fixture.original)
    await pending
    expect(fixture.renderSession().snapshots).toEqual([])
  })

  it('allows a reopened tab to refresh while an obsolete scan is pending', async () => {
    const fixture = refreshFixture()
    const old = deferred<RepositorySnapshot>()
    const fresh = deferred<RepositorySnapshot>()
    fixture.loadSnapshot.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const staleScan = fixture.renderRefresh().refreshActiveRepositorySnapshot()
    const path = fixture.original.repository.path
    fixture.session.removeRepositorySnapshot(path)
    fixture.session.applySnapshot(fixture.session.requests.beginOpen(path)!, snapshot(path, 'reopened'))
    const freshScan = fixture.renderRefresh().refreshActiveRepositorySnapshot()
    expect(fixture.loadSnapshot).toHaveBeenCalledTimes(2)
    old.reject(new Error('obsolete scan failed'))
    await staleScan
    expect(fixture.onRefreshError).not.toHaveBeenCalled()
    expect(fixture.renderRefresh().refreshingRepositoryPaths.has(path)).toBe(true)
    fresh.resolve(snapshot(path, 'fresh'))
    await freshScan
    expect(fixture.renderSession().snapshots[0].repository.revision).toBe('fresh')
    expect(fixture.renderRefresh().refreshingRepositoryPaths.size).toBe(0)
  })

  it('rejects a pre-mutation scan after a successful mutation is published', async () => {
    const fixture = refreshFixture()
    const scan = deferred<RepositorySnapshot>()
    fixture.loadSnapshot.mockReturnValueOnce(scan.promise)
    const pending = fixture.renderRefresh().refreshActiveRepositorySnapshot()
    const request = fixture.session.requests.beginMutation(fixture.original.repository.path)!
    expect(fixture.session.requests.beginRead(request.path, 'snapshot')).toBeNull()
    fixture.session.applySnapshot(request, snapshot(request.path, 'after-mutation'))
    fixture.session.requests.finishMutation(request)
    scan.resolve(fixture.original)
    await pending
    expect(fixture.renderSession().snapshots[0].repository.revision).toBe('after-mutation')
  })

  it('keeps the newest snapshot and history when responses arrive out of order', () => {
    const fixture = refreshFixture()
    const { session, original } = fixture
    const path = original.repository.path
    const old = session.requests.beginRead(path, 'snapshot')!
    const fresh = session.requests.beginRead(path, 'snapshot')!
    expect(session.applySnapshot(fresh, snapshot(path, 'fresh'))).toBe(true)
    expect(session.applySnapshot(old, original)).toBe(false)
    const firstHistory = session.requests.beginRead(path, 'history')!
    const secondHistory = session.requests.beginRead(path, 'history')!
    session.applyHistory(secondHistory, [revision('new-query')])
    expect(session.applyHistory(firstHistory, [revision('old-query')])).toBe(false)
    expect(fixture.renderSession().snapshots[0].revisions[0].id).toBe('new-query')
  })

  it('patches only history and preserves newer status and load timestamp', () => {
    const fixture = refreshFixture()
    const { session, original } = fixture
    const history = session.requests.beginRead(original.repository.path, 'history')!
    const fresh = { ...original, loadedAt: 'new-load', repository: { ...original.repository, ahead: 2 } }
    session.applySnapshot(session.requests.beginRead(history.path, 'snapshot')!, fresh)
    session.applyHistory(history, [revision('filtered')])
    expect(fixture.renderSession().snapshots[0]).toEqual({ ...fresh, revisions: [revision('filtered')] })
  })

  it('does not replace a completed custom history query with an older default scan', () => {
    const fixture = refreshFixture()
    const { session, original } = fixture
    const history = session.requests.beginRead(original.repository.path, 'history')!
    const scan = session.requests.beginRead(history.path, 'snapshot')!
    session.applyHistory(history, [revision('custom-query')])
    session.applySnapshot(scan, original)
    expect(fixture.renderSession().snapshots[0].revisions[0].id).toBe('custom-query')
  })

  it.each(['branch', 'revision'] as const)('rejects history after an external %s change', (field) => {
    const fixture = refreshFixture()
    const { session, original } = fixture
    const history = session.requests.beginRead(original.repository.path, 'history')!
    const changed = { ...original, repository: { ...original.repository, [field]: 'external-change' } }
    session.applySnapshot(session.requests.beginRead(history.path, 'snapshot')!, changed)
    expect(session.applyHistory(history, [revision('old-anchor')])).toBe(false)
    expect(fixture.renderSession().snapshots[0]).toEqual(changed)
  })

  it('rejects old history when a branch tip advances while HEAD stays unchanged', () => {
    const original = snapshot()
    original.branches = [
      {
        id: 'main',
        name: 'main',
        latest: 'tip-1',
        current: true,
        remote: false,
        archived: false,
        ahead: 0,
        author: 'Author'
      }
    ]
    const render = harness(() => useRepositorySession([original]))
    const session = render()
    const path = original.repository.path
    const history = session.requests.beginRead(path, 'history')!
    const advanced = {
      ...original,
      branches: [{ ...original.branches[0], latest: 'tip-2' }],
      revisions: [revision('tip-2')]
    }
    session.applySnapshot(session.requests.beginRead(path, 'snapshot')!, advanced)
    expect(session.applyHistory(history, [revision('tip-1')])).toBe(false)
    expect(render().snapshots[0]).toEqual(advanced)
  })

  it('processes consecutive closes against the latest state without a render between them', () => {
    const first = snapshot('/workspace/A')
    const second = snapshot('/workspace/B')
    const render = harness(() => useRepositorySession([first, second]))
    const session = render()
    session.removeRepositorySnapshot(first.repository.path)
    session.removeRepositorySnapshot(second.repository.path)
    expect(render().snapshots).toEqual([])
    expect(render().activeRepositoryId).toBe('')
  })

  it('keeps a newly opened tab when an old event handler closes another tab', () => {
    const first = snapshot()
    const render = harness(() => useRepositorySession([first]))
    const session = render()
    const second = snapshot('/workspace/a')
    session.applySnapshot(session.requests.beginOpen(second.repository.path)!, second)
    expect(render().snapshots).toHaveLength(2)
    session.removeRepositorySnapshot(first.repository.path)
    expect(render().snapshots).toEqual([second])
  })
})

function restoreFixture() {
  const renderSession = harness(() => useRepositorySession([]))
  const session = renderSession()
  const delayedRestore = deferred<RepositorySnapshot>()
  const loadPreferences = async () => ({ repositoryPaths: ['/saved/A'], activeRepositoryPath: '/saved/A' })
  const loadSnapshot = vi.fn(() => delayedRestore.promise)
  let busyAction: string | null = null
  const setBusyAction = (next: string | null | ((current: string | null) => string | null)) => {
    busyAction = typeof next === 'function' ? next(busyAction) : next
  }
  const updatePreferences = vi.fn()
  let current = session
  const renderLifecycle = harness(() => {
    return useRepositorySessionLifecycle({
      applicationMode: 'tauri',
      snapshots: current.snapshots,
      activeRepositoryId: current.activeRepositoryId,
      unavailableRepositoryPaths: current.unavailableRepositoryPaths,
      requests: session.requests,
      replaceRepositorySession: session.replaceRepositorySession,
      activateSnapshot: session.activateRepositorySnapshot,
      setBusyAction,
      updatePreferences,
      notify: vi.fn(),
      loadPreferences,
      loadSnapshot
    })
  }, true)
  // Read the session before rendering the lifecycle so each Hook has its own slots.
  const render = () => {
    current = renderSession()
    renderLifecycle()
    renderLifecycle.flushEffects()
  }
  render()
  return {
    session,
    renderSession,
    render,
    delayedRestore,
    loadSnapshot,
    setBusyAction,
    busyAction: () => busyAction,
    updatePreferences
  }
}

/** Flush the known restore promise chain without wall-clock timers. */
async function flushRestore() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

describe('startup restore ownership', () => {
  it('restores and persists saved tabs when no user interaction supersedes startup', async () => {
    const fixture = restoreFixture()
    await flushRestore()
    const saved = snapshot('/saved/A')
    fixture.delayedRestore.resolve(saved)
    await flushRestore()
    expect(fixture.renderSession().snapshots).toEqual([saved])
    expect(fixture.busyAction()).toBeNull()
    fixture.render()
    expect(fixture.updatePreferences).toHaveBeenLastCalledWith({
      repositoryPaths: ['/saved/A'],
      activeRepositoryPath: '/saved/A'
    })
  })

  it.each([false, true])('does not replace a manual open (already completed: %s)', async (completed) => {
    const fixture = restoreFixture()
    await flushRestore()
    expect(fixture.loadSnapshot).toHaveBeenCalledWith('/saved/A')
    const opened = snapshot('/manual/B')
    const request = fixture.session.requests.beginOpen(opened.repository.path)!
    fixture.setBusyAction('openingRepository')
    if (completed) fixture.session.applySnapshot(request, opened)
    fixture.delayedRestore.resolve(snapshot('/saved/A'))
    await flushRestore()
    expect(fixture.session.requests.isCurrent(request)).toBe(true)
    expect(fixture.busyAction()).toBe('openingRepository')
    expect(fixture.renderSession().snapshots).toEqual(completed ? [opened] : [])
    if (!completed) expect(fixture.session.applySnapshot(request, opened)).toBe(true)
    fixture.session.activateRepositorySnapshot(opened)
    fixture.render()
    expect(fixture.updatePreferences).toHaveBeenLastCalledWith({
      repositoryPaths: ['/manual/B'],
      activeRepositoryPath: '/manual/B'
    })
  })

  it('does not reopen saved tabs after a user closes all tabs', async () => {
    const fixture = restoreFixture()
    await flushRestore()
    fixture.session.replaceRepositorySession([], [])
    fixture.delayedRestore.resolve(snapshot('/saved/A'))
    await flushRestore()
    expect(fixture.renderSession().snapshots).toEqual([])
    expect(fixture.busyAction()).toBeNull()
    fixture.render()
    expect(fixture.updatePreferences).toHaveBeenLastCalledWith({
      repositoryPaths: [],
      activeRepositoryPath: null
    })
  })

  it('skips a restore invalidated before its startup microtask and still enables persistence', async () => {
    const fixture = restoreFixture()
    fixture.session.replaceRepositorySession([], [])
    await flushRestore()
    expect(fixture.loadSnapshot).not.toHaveBeenCalled()
    fixture.render()
    expect(fixture.updatePreferences).toHaveBeenCalledWith({
      repositoryPaths: [],
      activeRepositoryPath: null
    })
  })
})

function directoryFixture() {
  const renderSession = harness(() => useRepositorySession([]))
  const session = renderSession()
  const services = {
    listAuthIdentities: vi.fn(async () => []),
    listRemoteRepositories: vi.fn<() => Promise<RemoteRepository[]>>(),
    hydrateRemoteRepositoryDetails: vi.fn(async () => undefined),
    loadRemoteRepositoryInfo: vi.fn(async () => ({ id: 'repo', name: 'repo' })),
    cloneRepository: vi.fn(() => new Promise<never>(() => undefined))
  }
  const notify = vi.fn()
  const render = harness(() =>
    useRepositoryEntryController({
      applicationMode: 'tauri',
      defaultIdentity: '',
      sharedStoreInfo: null,
      activateRepositorySnapshot: session.activateRepositorySnapshot,
      requests: session.requests,
      applySnapshot: session.applySnapshot,
      setActiveView: vi.fn(),
      setServerDialogOpen: vi.fn(),
      tryBeginRepositoryMutation: () => true,
      finishRepositoryMutation: vi.fn(),
      beginOperation: () => ({ id: 1, startedAt: 0 }),
      finishOperation: vi.fn(),
      refreshSharedStores: async () => undefined,
      notify,
      serverDialogOpen: true,
      authStateVersion: 0,
      onAuthenticationRequired: vi.fn(),
      onAuthStateChange: async () => undefined,
      dependencies: services
    })
  )
  return { render, services, notify }
}

describe('server directory publication races', () => {
  it('rejects a stale row event after another server directory has been published', async () => {
    const { render, services } = directoryFixture()
    const repository = { id: 'a', name: 'only-on-a' }
    services.listRemoteRepositories.mockResolvedValueOnce([repository]).mockResolvedValueOnce([{ id: 'b', name: 'b' }])
    await render().openServer()
    const oldDirectory = render().serverDialog
    oldDirectory.onBrowserServerUrlChange('lore://b')
    await render().openServer()
    oldDirectory.onClone(repository)
    expect(services.loadRemoteRepositoryInfo).not.toHaveBeenCalled()
    expect(render().cloneDialog).toBeNull()
  })

  it('keeps a newer directory when the old List response arrives last', async () => {
    const { render, services } = directoryFixture()
    const first = deferred<RemoteRepository[]>()
    const second = deferred<RemoteRepository[]>()
    services.listRemoteRepositories.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const old = render().openServer()
    render().serverDialog.onBrowserServerUrlChange('lore://second')
    const fresh = render().openServer()
    second.resolve([{ id: 'second', name: 'second' }])
    await fresh
    first.resolve([{ id: 'first', name: 'first' }])
    await old
    expect(render().serverDialog.repositories).toEqual([{ id: 'second', name: 'second' }])
    expect(services.hydrateRemoteRepositoryDetails).toHaveBeenCalledTimes(1)
  })

  it('does not let an obsolete failure clear the current loading state or show an error', async () => {
    const { render, services } = directoryFixture()
    const first = deferred<RemoteRepository[]>()
    const second = deferred<RemoteRepository[]>()
    services.listRemoteRepositories.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const old = render().openServer()
    render().serverDialog.onSelectedUserIdChange('new-user')
    const fresh = render().openServer()
    first.reject(new Error('old directory failed'))
    await old
    expect(render().serverDialog.error).toBeNull()
    expect(render().serverDialog.loading).toBe(true)
    second.resolve([])
    await fresh
    expect(render().serverDialog.loading).toBe(false)
  })

  it('ignores List results after closing the server dialog', async () => {
    const { render, services } = directoryFixture()
    const list = deferred<RemoteRepository[]>()
    services.listRemoteRepositories.mockReturnValueOnce(list.promise)
    const pending = render().openServer()
    render().serverDialog.onClose()
    list.resolve([{ id: 'old', name: 'old' }])
    await pending
    expect(render().serverDialog.repositories).toEqual([])
  })

  it('ignores obsolete details and keeps clone bound to the directory source', async () => {
    const { render, services } = directoryFixture()
    const repository = { id: 'repo', name: 'repo' }
    render().serverDialog.onBrowserServerUrlChange('lore://queried')
    render().serverDialog.onSelectedUserIdChange('queried-user')
    services.listRemoteRepositories.mockResolvedValue([repository])
    await render().openServer()
    const details = deferred<RemoteRepository>()
    services.loadRemoteRepositoryInfo.mockReturnValueOnce(details.promise)
    render().serverDialog.onClone(repository)
    render().serverDialog.onBrowserServerUrlChange('lore://other')
    details.resolve(repository)
    await Promise.resolve()
    expect(render().cloneDialog).toBeNull()

    render().serverDialog.onBrowserServerUrlChange('lore://queried')
    await render().openServer()
    render().serverDialog.onClone(repository)
    await Promise.resolve()
    render().serverDialog.onBrowserServerUrlChange('lore://edited')
    render().serverDialog.onSelectedUserIdChange('edited-user')
    const clone = render().cloneDialog!
    expect(clone.serverUrl).toBe('lore://queried')
    clone.onConfirm('/tmp', 'clone', '', { useSharedStore: false })
    expect(services.cloneRepository).toHaveBeenCalledWith(
      'lore://queried',
      'repo',
      '/tmp',
      'clone',
      '',
      { useSharedStore: false },
      'queried-user'
    )
  })
})
