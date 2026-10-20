import { afterAll, beforeEach, describe, expect, it, vi } from 'bun:test'

import type {
  LoreDependencyGraphQuery,
  LoreFileLock,
  LoreLayer,
  LoreLink,
  LoreLinkDetails,
  RepositorySnapshot,
  RepositoryView
} from '../../types'

interface HookState {
  cursor: number
  values: unknown[]
  effects: (() => void)[]
}

let currentHooks: HookState
function memoizeHook<T>(factory: () => T, dependencies: readonly unknown[]): T {
  const hooks = currentHooks
  const index = hooks.cursor++
  const previous = hooks.values[index] as { dependencies: readonly unknown[]; value: T } | undefined
  if (
    previous &&
    dependencies.length === previous.dependencies.length &&
    dependencies.every((value, index) => Object.is(value, previous.dependencies[index]))
  )
    return previous.value
  const value = factory()
  hooks.values[index] = { dependencies, value }
  return value
}

const reactActual = { ...(await import('react')) }
const loreActual = { ...(await import('../../services/lore')) }
const listLayers = vi.fn<() => Promise<LoreLayer[]>>(() => Promise.resolve([]))
const listLinks = vi.fn<() => Promise<LoreLink[]>>(() => Promise.resolve([]))
const loadRepositoryView = vi.fn<() => Promise<RepositoryView>>()
const loadFileDependencyGraph = vi.fn<() => Promise<LoreDependencyGraphQuery>>()
const loginAuthInteractive = vi.fn(async () => {})
const setRepositoryAuthAccountBinding = vi.fn(async () => {})
const loadLinkInfo = vi.fn<() => Promise<LoreLinkDetails>>()
const queryFileLocks = vi.fn<() => Promise<LoreFileLock[]>>()
const loadFileLockStatus = vi.fn<() => Promise<LoreFileLock[]>>()

vi.mock('../../services/lore', () => ({
  ...loreActual,
  listLayers,
  listLinks,
  loadRepositoryView,
  loadFileDependencyGraph,
  loginAuthInteractive,
  setRepositoryAuthAccountBinding,
  loadLinkInfo,
  queryFileLocks,
  loadFileLockStatus
}))
vi.mock('react', () => ({
  ...reactActual,
  useCallback: <T>(callback: T, dependencies: readonly unknown[]) => memoizeHook(() => callback, dependencies),
  useMemo: memoizeHook,
  useEffect: (effect: () => void | (() => void), dependencies?: readonly unknown[]) => {
    const hooks = currentHooks
    const index = hooks.cursor++
    const previous = hooks.values[index] as { dependencies?: readonly unknown[]; cleanup?: () => void } | undefined
    if (
      dependencies &&
      previous?.dependencies &&
      dependencies.length === previous.dependencies.length &&
      dependencies.every((value, index) => Object.is(value, previous.dependencies![index]))
    )
      return
    hooks.effects.push(() => {
      previous?.cleanup?.()
      hooks.values[index] = { dependencies, setup: effect, cleanup: effect() }
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
afterAll(() => {
  vi.mock('react', () => reactActual)
  vi.mock('../../services/lore', () => loreActual)
})

const { useRepositoryToolsController } = await import('./useRepositoryToolsController')

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

function snapshot(path = '/workspace/A'): RepositorySnapshot {
  return {
    repository: {
      id: 'shared-repository-id',
      name: path,
      path,
      branch: 'main',
      revision: 'current-revision',
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

function query(path: string): LoreDependencyGraphQuery {
  return {
    revision: 'current-revision',
    groups: [],
    nodes: [{ path, distance: 0, root: true }],
    edges: [],
    reverse: false,
    recursive: true,
    depthLimit: 0,
    truncated: false,
    nodeLimit: 240
  }
}

function layer(id: string): LoreLayer {
  return {
    id,
    targetPath: id,
    sourceRepository: 'source',
    sourcePath: '/',
    metadata: '',
    revision: 'r',
    stagedFileCount: 0
  }
}

function link(id: string): LoreLink {
  return {
    id,
    linkPath: id,
    repository: 'source',
    sourcePath: '/',
    branchName: 'main',
    revision: 'r',
    flags: 0,
    disableAutoFollow: false,
    stagedFileCount: 0
  }
}

function view(content: string): RepositoryView {
  return {
    path: '.lore/view',
    exists: true,
    content,
    valid: true,
    ruleCount: 1,
    exclusionCount: 1,
    inclusionCount: 0,
    diagnostics: []
  }
}

const selection = { rootFiles: ['file'], tags: [], recursive: true, depthLimit: 0 }

function fixture() {
  const hooks: HookState = { cursor: 0, values: [], effects: [] }
  const options = {
    applicationMode: 'tauri' as const,
    activeSnapshot: snapshot(),
    repositorySnapshots: [],
    authAccountBindings: [],
    onAuthAccountBindingsChange: vi.fn(),
    authStateVersion: 0,
    onAuthenticationRequired: vi.fn(),
    onAuthStateChange: vi.fn(async () => {}),
    defaultIdentity: '',
    busyAction: null,
    notify: vi.fn(),
    openRepository: vi.fn(async () => {}),
    runRepositoryMutation: vi.fn(async () => true),
    upsertSnapshot: vi.fn(),
    pushCurrentRepository: vi.fn(async () => {}),
    locateRevision: vi.fn()
  }
  const render = () => {
    currentHooks = hooks
    hooks.cursor = 0
    const result = useRepositoryToolsController(options)
    for (const effect of hooks.effects.splice(0)) effect()
    return result
  }
  const dispose = () => {
    for (const value of hooks.values) {
      if (value && typeof value === 'object' && 'cleanup' in value && typeof value.cleanup === 'function') {
        value.cleanup()
      }
    }
  }
  const replayEffects = () => {
    for (const value of hooks.values) {
      if (value && typeof value === 'object' && 'setup' in value && typeof value.setup === 'function') {
        if ('cleanup' in value && typeof value.cleanup === 'function') value.cleanup()
        Object.assign(value, { cleanup: value.setup() })
      }
    }
  }
  return { options, render, dispose, replayEffects }
}

beforeEach(() => {
  listLayers.mockReset().mockResolvedValue([])
  listLinks.mockReset().mockResolvedValue([])
  loadRepositoryView.mockReset()
  loadFileDependencyGraph.mockReset()
  loginAuthInteractive.mockReset().mockResolvedValue(undefined)
  setRepositoryAuthAccountBinding.mockReset().mockResolvedValue(undefined)
  loadLinkInfo.mockReset()
  queryFileLocks.mockReset()
  loadFileLockStatus.mockReset().mockResolvedValue([])
})

describe('repository tools resource ownership', () => {
  for (const target of ['maintenance', 'accounts'] as const) {
    it(`clears the previous loading state when switching to ${target}`, async () => {
      const layers = deferred<LoreLayer[]>()
      listLayers.mockReturnValue(layers.promise)
      const { render } = fixture()
      const opening = render().open('layers')
      expect(render().dialogProps?.loading).toBe(true)
      await render().open(target)
      expect(render().dialogProps?.loading).toBe(false)
      layers.resolve([])
      await opening
      expect(render().dialogProps?.loading).toBe(false)
    })
  }

  it('keeps the latest dependency result when queries complete out of order', async () => {
    const first = deferred<LoreDependencyGraphQuery>()
    const second = deferred<LoreDependencyGraphQuery>()
    loadFileDependencyGraph.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { render } = fixture()
    await render().open('dependencies')
    const callback = render().dialogProps!.onQueryDependencies!
    const oldRequest = callback(['old'], selection, false)
    const currentRequest = callback(['current'], selection, false)
    second.resolve(query('current'))
    await currentRequest
    first.resolve(query('old'))
    expect(await oldRequest).toBeNull()
    expect(render().dialogProps?.dependencyQuery?.nodes[0].path).toBe('current')
  })

  it('does not clear a newer dependency query loading state when an obsolete query fails', async () => {
    const first = deferred<LoreDependencyGraphQuery>()
    const second = deferred<LoreDependencyGraphQuery>()
    loadFileDependencyGraph.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { render, options } = fixture()
    await render().open('dependencies')
    const callback = render().dialogProps!.onQueryDependencies!
    const oldRequest = callback(['old'], selection, false)
    const currentRequest = callback(['current'], selection, false)
    first.reject(new Error('Obsolete failure'))
    await oldRequest
    expect(render().dialogProps?.loading).toBe(true)
    expect(options.notify).not.toHaveBeenCalled()
    second.resolve(query('current'))
    await currentRequest
    expect(render().dialogProps?.loading).toBe(false)
  })

  it('does not revive resources after closing and reopening the same repository', async () => {
    const old = deferred<LoreDependencyGraphQuery>()
    const current = deferred<LoreDependencyGraphQuery>()
    loadFileDependencyGraph.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const { render } = fixture()
    await render().open('dependencies')
    const oldCallback = render().dialogProps!.onQueryDependencies!
    const oldRequest = oldCallback(['old'], selection, false)
    render().close()
    await render().open('dependencies')
    const currentRequest = render().dialogProps!.onQueryDependencies!(['current'], selection, false)
    old.resolve(query('old'))
    expect(await oldRequest).toBeNull()
    expect(render().dialogProps?.dependencyQuery).toBeNull()
    expect(render().dialogProps?.loading).toBe(true)
    expect(await oldCallback(['late callback'], selection, false)).toBeNull()
    expect(loadFileDependencyGraph).toHaveBeenCalledTimes(2)
    current.resolve(query('current'))
    await currentRequest
    expect(render().dialogProps?.dependencyQuery?.nodes[0].path).toBe('current')
  })

  it('does not attach a dependency result to another workspace with the same repository ID', async () => {
    const old = deferred<LoreDependencyGraphQuery>()
    loadFileDependencyGraph.mockReturnValue(old.promise)
    const { render, options } = fixture()
    await render().open('dependencies')
    const oldRequest = render().dialogProps!.onQueryDependencies!(['old'], selection, false)
    options.activeSnapshot = snapshot('/workspace/B')
    render()
    await Promise.resolve()
    old.resolve(query('old'))
    expect(await oldRequest).toBeNull()
    expect(render().dialogProps?.repository.path).toBe('/workspace/B')
    expect(render().dialogProps?.dependencyQuery).toBeNull()
  })

  it('does not notify or restore loading after the controller unmounts', async () => {
    const pending = deferred<LoreDependencyGraphQuery>()
    loadFileDependencyGraph.mockReturnValue(pending.promise)
    const { render, options, dispose } = fixture()
    await render().open('dependencies')
    const request = render().dialogProps!.onQueryDependencies!(['old'], selection, false)
    dispose()
    pending.reject(new Error('Failed after unmount'))
    expect(await request).toBeNull()
    expect(options.notify).not.toHaveBeenCalled()
  })

  it('still reports a current dependency failure and completes its loading state', async () => {
    loadFileDependencyGraph.mockRejectedValue(new Error('Current failure'))
    const { render, options } = fixture()
    await render().open('dependencies')
    expect(await render().dialogProps!.onQueryDependencies!(['file'], selection, false)).toBeNull()
    expect(options.notify).toHaveBeenCalledTimes(1)
    expect(render().dialogProps?.loading).toBe(false)
  })

  it('accepts fresh reads after StrictMode effect replay while rejecting the prior read', async () => {
    const old = deferred<LoreDependencyGraphQuery>()
    const current = deferred<LoreDependencyGraphQuery>()
    loadFileDependencyGraph.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const { render, replayEffects } = fixture()
    await render().open('dependencies')
    const oldRequest = render().dialogProps!.onQueryDependencies!(['old'], selection, false)
    replayEffects()
    const currentRequest = render().dialogProps!.onQueryDependencies!(['current'], selection, false)
    old.resolve(query('old'))
    expect(await oldRequest).toBeNull()
    expect(render().dialogProps?.loading).toBe(true)
    current.resolve(query('current'))
    expect(await currentRequest).toEqual(query('current'))
    expect(render().dialogProps?.dependencyQuery?.nodes[0].path).toBe('current')
    expect(render().dialogProps?.loading).toBe(false)
  })

  it('does not reopen tools when they are closed before a queued repository change finishes', async () => {
    const { render, options } = fixture()
    await render().open('layers')
    options.activeSnapshot = snapshot('/workspace/B')
    render().close()
    await Promise.resolve()
    expect(render().dialogProps).toBeNull()
    expect(listLayers).toHaveBeenCalledTimes(1)
  })

  it('keeps an account write pending while a page read finishes', async () => {
    const write = deferred<void>()
    const layers = deferred<LoreLayer[]>()
    const { render, options } = fixture()
    options.onAuthStateChange.mockReturnValue(write.promise)
    await render().open('accounts')
    const auth = render().dialogProps!.onLoginAuthInteractive!('https://example.com')
    await Promise.resolve()
    listLayers.mockReturnValueOnce(layers.promise)
    const opening = render().open('layers')
    layers.resolve([])
    await opening
    expect(render().dialogProps?.loading).toBe(true)
    write.resolve()
    expect(await auth).toBe(true)
    expect(render().dialogProps?.loading).toBe(false)
  })

  for (const firstToFinish of ['binding', 'page'] as const) {
    it(`keeps account binding and page loading independent when ${firstToFinish} finishes first`, async () => {
      const write = deferred<void>()
      const layers = deferred<LoreLayer[]>()
      const { render, options } = fixture()
      options.onAuthStateChange.mockReturnValue(write.promise)
      await render().open('accounts')
      const props = render().dialogProps!
      const binding = props.onSetAuthAccountBinding!(props.repository)
      await Promise.resolve()
      listLayers.mockReturnValueOnce(layers.promise)
      const opening = render().open('layers')
      if (firstToFinish === 'binding') {
        write.resolve()
        expect(await binding).toBe(true)
      } else {
        layers.resolve([])
        await opening
      }
      expect(render().dialogProps?.loading).toBe(true)
      write.resolve()
      layers.resolve([])
      expect(await binding).toBe(true)
      await opening
      expect(render().dialogProps?.loading).toBe(false)
      expect(options.onAuthAccountBindingsChange).toHaveBeenCalledTimes(1)
    })
  }

  it('discards a layer refresh from a mutation completed in an earlier tool session', async () => {
    const old = deferred<LoreLayer[]>()
    listLayers
      .mockResolvedValueOnce([layer('initial')])
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce([layer('current')])
    const { render } = fixture()
    await render().open('layers')
    const mutation = render().dialogProps!.onAddLayer({
      targetPath: 'layer',
      sourceRepository: 'source',
      sourcePath: '/'
    })
    await Promise.resolve()
    render().close()
    await render().open('layers')
    old.resolve([layer('old')])
    expect(await mutation).toBe(true)
    expect(render().dialogProps?.layers.map((entry) => entry.id)).toEqual(['current'])
  })

  it('does not start a late layer refresh after leaving the mutation tool session', async () => {
    const write = deferred<boolean>()
    const { render, options } = fixture()
    options.runRepositoryMutation.mockReturnValue(write.promise)
    await render().open('layers')
    const mutation = render().dialogProps!.onAddLayer({
      targetPath: 'layer',
      sourceRepository: 'source',
      sourcePath: '/'
    })
    render().close()
    await render().open('maintenance')
    write.resolve(true)
    expect(await mutation).toBe(true)
    expect(listLayers).toHaveBeenCalledTimes(1)
  })

  it('refreshes layers after a successful mutation in the current session', async () => {
    listLayers.mockResolvedValueOnce([layer('initial')]).mockResolvedValueOnce([layer('updated')])
    const { render } = fixture()
    await render().open('layers')
    expect(
      await render().dialogProps!.onAddLayer({ targetPath: 'layer', sourceRepository: 'source', sourcePath: '/' })
    ).toBe(true)
    expect(render().dialogProps?.layers.map((entry) => entry.id)).toEqual(['updated'])
    expect(render().dialogProps?.loading).toBe(false)
  })

  it('discards a link refresh error after changing tools', async () => {
    const old = deferred<LoreLink[]>()
    listLinks.mockResolvedValueOnce([link('initial')]).mockReturnValueOnce(old.promise)
    const { render, options } = fixture()
    await render().open('links')
    const mutation = render().dialogProps!.onRemoveLink('initial')
    await Promise.resolve()
    await render().open('maintenance')
    old.reject(new Error('Failed old refresh'))
    expect(await mutation).toBe(true)
    expect(options.notify).not.toHaveBeenCalled()
    expect(render().dialogProps?.loading).toBe(false)
  })

  it('keeps a newly opened View when an old apply follow-up read completes', async () => {
    const old = deferred<RepositoryView>()
    loadRepositoryView
      .mockResolvedValueOnce(view('initial'))
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(view('current'))
    const { render } = fixture()
    await render().open('view')
    const mutation = render().dialogProps!.onApplyView('changed')
    await Promise.resolve()
    render().close()
    await render().open('view')
    old.resolve(view('old'))
    expect(await mutation).toBe(true)
    expect(render().dialogProps?.repositoryView?.content).toBe('current')
  })

  it('refreshes the current View after apply succeeds', async () => {
    loadRepositoryView.mockResolvedValueOnce(view('initial')).mockResolvedValueOnce(view('updated'))
    const { render } = fixture()
    await render().open('view')
    expect(await render().dialogProps!.onApplyView('updated')).toBe(true)
    expect(render().dialogProps?.repositoryView?.content).toBe('updated')
    expect(render().dialogProps?.loading).toBe(false)
  })

  it('drops late Link details and rejects old callbacks after reopening', async () => {
    const pending = deferred<LoreLinkDetails>()
    loadLinkInfo.mockReturnValue(pending.promise)
    const { render, options } = fixture()
    await render().open('links')
    const oldCallback = render().dialogProps!.onLoadLinkInfo!
    const oldRequest = oldCallback('link')
    render().close()
    await render().open('links')
    pending.reject(new Error('Obsolete Link details'))
    expect(await oldRequest).toBeNull()
    expect(await oldCallback('link')).toBeNull()
    expect(loadLinkInfo).toHaveBeenCalledTimes(1)
    expect(options.notify).not.toHaveBeenCalled()
  })

  it('keeps workspace locks available after the tools page closes', async () => {
    const pending = deferred<LoreFileLock[]>()
    queryFileLocks.mockReturnValue(pending.promise)
    const { render } = fixture()
    // Finish the initial workspace effect before explicitly loading all locks.
    render()
    await Promise.resolve()
    const opening = render().open('locks')
    render().close()
    const locks = [{ path: 'file', branch: 'main', owner: 'user', lockedAt: 1 }]
    pending.resolve(locks)
    await opening
    expect(render().fileLocks).toEqual(locks)
    expect(render().dialogProps).toBeNull()
  })

  it('refreshes current workspace locks when its mutation finishes after tools close', async () => {
    const write = deferred<boolean>()
    const locks = [{ path: 'file', branch: 'main', owner: 'user', lockedAt: 1 }]
    queryFileLocks.mockResolvedValue(locks)
    const { render, options } = fixture()
    await render().open('maintenance')
    options.runRepositoryMutation.mockReturnValueOnce(write.promise)
    const mutation = render().acquireFileLocks(['file'])
    render().close()
    write.resolve(true)
    expect(await mutation).toBe(true)
    expect(render().fileLocks).toEqual(locks)
    expect(render().dialogProps).toBeNull()
  })

  it('does not start a queued lock status read for a workspace already left', async () => {
    const { render, options } = fixture()
    options.activeSnapshot.changes = [
      {
        id: 'file',
        path: 'file',
        name: 'file',
        contentClassification: { kind: 'unknown', source: 'deferred' },
        status: 'modified',
        staged: false,
        additions: 0,
        deletions: 0
      }
    ]
    render()
    options.activeSnapshot = snapshot('/workspace/B')
    render()
    await Promise.resolve()
    await Promise.resolve()
    expect(loadFileLockStatus).not.toHaveBeenCalled()
    expect(render().fileLocks).toEqual([])
  })

  for (const nextWorkspace of ['repository', 'branch'] as const) {
    it(`does not refresh old locks after a mutation finishes in another ${nextWorkspace}`, async () => {
      const write = deferred<boolean>()
      const locks = [{ path: 'old-workspace-file', branch: 'main', owner: 'user', lockedAt: 1 }]
      queryFileLocks.mockResolvedValueOnce(locks).mockResolvedValueOnce([]).mockResolvedValue(locks)
      const { render, options } = fixture()
      await render().open('locks')
      options.runRepositoryMutation.mockReturnValueOnce(write.promise)
      const mutation = render().acquireFileLocks(['old-workspace-file'])
      const nextSnapshot = snapshot(nextWorkspace === 'repository' ? '/workspace/B' : '/workspace/A')
      if (nextWorkspace === 'branch') nextSnapshot.repository.branch = 'other-branch'
      options.activeSnapshot = nextSnapshot
      render()
      await render().open('locks')
      expect(render().fileLocks).toEqual([])
      write.resolve(true)
      expect(await mutation).toBe(true)
      expect(render().fileLocks).toEqual([])
      expect(queryFileLocks).toHaveBeenCalledTimes(2)
    })
  }
})
