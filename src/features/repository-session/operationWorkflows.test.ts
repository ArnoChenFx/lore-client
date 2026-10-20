import { afterAll, beforeEach, describe, expect, it, vi } from 'bun:test'

import {
  acquireOperationRequest,
  createOperationContext,
  getActiveOperationRequests,
  subscribeOperationRequests
} from '../../services/operationRequests'
import type { ChangeFile, OperationContext, RepositorySnapshot } from '../../types'

const invokeMock = vi.fn()
const tauriActual = { ...(await import('@tauri-apps/api/core')) }
const reactActual = { ...(await import('react')) }
vi.mock('@tauri-apps/api/core', () => ({ ...tauriActual, invoke: invokeMock, isTauri: () => true }))
// This controller only needs local state and callbacks; IPC and mutation lifecycle stay real.
vi.mock('react', () => ({
  ...reactActual,
  useState: <T>(initial: T | (() => T)) => [typeof initial === 'function' ? (initial as () => T)() : initial, vi.fn()],
  useCallback: <T>(callback: T) => callback
}))
const { loadRepositorySnapshot, publishRepository, setRepositoryAuthAccountBinding, stagePaths } =
  await import('../../services/lore')
const { useLocalChangeActions } = await import('../local-changes')
const { runRepositoryMutationLifecycle } = await import('./runRepositoryMutation')
const { refreshRepositoryAuthenticationState } = await import('./remoteAuthentication')

afterAll(() => {
  vi.mock('@tauri-apps/api/core', () => tauriActual)
  vi.mock('react', () => reactActual)
})

function snapshot(path: string): RepositorySnapshot {
  return {
    repository: {
      id: path,
      name: path,
      path,
      branch: 'main',
      revision: '',
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
    loadedAt: ''
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

function nativeResult(command: string, args: Record<string, unknown>) {
  const context = args.operationContext as OperationContext
  if (command === 'lore_tag_list') return []
  if (command === 'lore_repository_publish') return { pushed: true, failureStage: null }
  return { ...context, operation: command, status: 0, durationMs: 1, events: [], entries: [] }
}

function lifecycle(activeSnapshot: RepositorySnapshot) {
  const operations: OperationContext[] = []
  const run = (
    labelKey: string,
    task: (repository: RepositorySnapshot['repository'], context: OperationContext) => Promise<unknown>
  ) =>
    runRepositoryMutationLifecycle({
      activeSnapshot,
      labelKey,
      task,
      successDetail: 'Done',
      loadSnapshot: loadRepositorySnapshot,
      applySnapshot: vi.fn(),
      selectView: vi.fn(),
      focusConflictFile: vi.fn(),
      conflictTitle: () => '',
      notify: vi.fn(),
      beginOperation: (_label, _detail, workspaceKey) => {
        const context = createOperationContext(workspaceKey)
        operations.push(context)
        return { context, startedAt: performance.now(), release: acquireOperationRequest(context) }
      },
      finishOperation: (operation) => operation.release()
    })
  return { run, operations }
}

function stageController(path: string) {
  const activeSnapshot = snapshot(path)
  const mutation = lifecycle(activeSnapshot)
  const actions = useLocalChangeActions({
    applicationMode: 'tauri',
    activeSnapshot,
    activeRepository: activeSnapshot.repository,
    selectedRevision: null,
    revisionDiffSource: null,
    diffPreferences: {
      contextLines: 3,
      diffStyle: 'unified',
      expandFullFile: false,
      ignoreWhitespaceEol: false,
      ignoreWhitespaceInline: false
    },
    defaultIdentity: '',
    notify: vi.fn(),
    runRepositoryMutation: mutation.run,
    upsertSnapshot: vi.fn()
  })
  return { ...mutation, actions }
}

const files: ChangeFile[] = [
  {
    id: 'regular',
    name: 'regular.txt',
    path: 'docs',
    status: 'modified',
    staged: false,
    additions: 1,
    deletions: 0,
    contentClassification: { kind: 'text', source: 'utf8' }
  },
  {
    id: 'move',
    name: 'new.txt',
    path: 'docs',
    previousPath: 'docs/old.txt',
    status: 'renamed',
    staged: false,
    additions: 0,
    deletions: 0,
    contentClassification: { kind: 'text', source: 'utf8' }
  }
]

beforeEach(() => {
  expect(getActiveOperationRequests()).toEqual([])
  invokeMock.mockReset().mockImplementation(async (command, args) => nativeResult(command, args))
})

describe('workflow operation identity at the IPC boundary', () => {
  it('keeps stage, move and authoritative snapshot under one request while overlapping A/B workflows stay isolated', async () => {
    const firstStage = deferred<unknown>()
    invokeMock.mockImplementation(async (command, args) => {
      if (command === 'lore_stage' && args.repositoryPath === '/work/A') return firstStage.promise
      return nativeResult(command, args)
    })
    const events: string[] = []
    const unsubscribe = subscribeOperationRequests(({ type, context }) => events.push(`${type}:${context.requestId}`))
    const a = stageController('/work/A')
    const b = stageController('/work/B')
    try {
      const pendingA = a.actions.stageChangeFiles(files, true)
      const pendingB = b.actions.stageChangeFiles(files, true)
      expect(getActiveOperationRequests()).toHaveLength(2)
      await pendingB
      expect(getActiveOperationRequests()).toEqual([a.operations[0]])
      const firstArgs = invokeMock.mock.calls[0][1]
      firstStage.resolve(nativeResult('lore_stage', firstArgs))
      await pendingA
      for (const controller of [a, b]) {
        const context = controller.operations[0]
        const calls = invokeMock.mock.calls.filter(([, args]) => args.repositoryPath === context.workspaceKey)
        expect(calls.map(([command]) => command)).toEqual([
          'lore_stage',
          'lore_stage_move',
          'lore_repository_status',
          'lore_branch_list',
          'lore_revision_history',
          'lore_tag_list',
          'lore_repository_config_get',
          'lore_repository_config_get'
        ])
        for (const [, args] of calls) expect(args.operationContext).toEqual(context)
        expect(events.filter((event) => event.endsWith(context.requestId))).toEqual([
          `started:${context.requestId}`,
          `finished:${context.requestId}`
        ])
      }
      expect(a.operations[0].requestId).not.toBe(b.operations[0].requestId)
      expect(getActiveOperationRequests()).toEqual([])
    } finally {
      unsubscribe()
    }
  })

  it('retains publish account selection, native publish stages and the final snapshot under the repository owner', async () => {
    const mutation = lifecycle(snapshot('/work/publish'))
    const result = await mutation.run('publishRepository', async (repository, context) => {
      await setRepositoryAuthAccountBinding(repository.path, 'user', 'https://auth.example', context)
      return publishRepository(repository.path, 'project', '', '', '', 'lore://example', 'main', 'user', context)
    })
    expect(result).toBe(true)
    expect(invokeMock.mock.calls.slice(0, 3).map(([command]) => command)).toEqual([
      'lore_auth_repository_binding_set',
      'lore_repository_publish',
      'lore_repository_status'
    ])
    for (const [, args] of invokeMock.mock.calls) expect(args.operationContext).toEqual(mutation.operations[0])
    expect(getActiveOperationRequests()).toEqual([])
  })

  it('uses the failed write identity for recovery reads and releases the workflow when recovery also fails', async () => {
    invokeMock.mockImplementation(async (command) => {
      throw new Error(`failed:${command}`)
    })
    const mutation = lifecycle(snapshot('/work/failed'))
    expect(await mutation.run('stageFiles', (repository, context) => stagePaths(repository.path, ['a'], context))).toBe(
      false
    )
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual(['lore_stage', 'lore_repository_status'])
    for (const [, args] of invokeMock.mock.calls) expect(args.operationContext).toEqual(mutation.operations[0])
    expect(getActiveOperationRequests()).toEqual([])
  })

  it('gives standalone composite snapshots independent roots without finishing between child commands', async () => {
    const events: Array<{ type: string; context: OperationContext }> = []
    const unsubscribe = subscribeOperationRequests((event) => events.push(event))
    try {
      await Promise.all([loadRepositorySnapshot('/work/A'), loadRepositorySnapshot('/work/B')])
      expect(events.filter(({ type }) => type === 'started')).toHaveLength(2)
      expect(events.filter(({ type }) => type === 'finished')).toHaveLength(2)
      for (const path of ['/work/A', '/work/B']) {
        const calls = invokeMock.mock.calls.filter(([, args]) => args.repositoryPath === path)
        expect(calls.length).toBeGreaterThan(1)
        expect(new Set(calls.map(([, args]) => args.operationContext.requestId)).size).toBe(1)
      }
      expect(getActiveOperationRequests()).toEqual([])
    } finally {
      unsubscribe()
    }
  })

  it('preserves a global authentication recovery owner while refreshing repositories A and B', async () => {
    const context = createOperationContext(null)
    const result = await refreshRepositoryAuthenticationState(
      [snapshot('/work/A'), snapshot('/work/B')],
      () => undefined,
      undefined,
      context
    )
    expect(result.failedCount).toBe(0)
    expect(invokeMock.mock.calls[0][0]).toBe('lore_auth_repository_contexts_refresh')
    for (const [, args] of invokeMock.mock.calls) expect(args.operationContext).toEqual(context)
    expect(getActiveOperationRequests()).toEqual([])
  })
})
