import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test'

import {
  acquireOperationRequest,
  createOperationContext,
  getActiveOperationRequests,
  subscribeOperationRequests
} from './operationRequests'

const invokeMock = vi.fn()
const tauriCore = await import('@tauri-apps/api/core')
vi.mock('@tauri-apps/api/core', () => ({ ...tauriCore, invoke: invokeMock, isTauri: () => true }))
const { invokeLogged } = await import('./logging')
const { invokeCommand, runOperation } = await import('./lore/core')

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('IPC operation ownership', () => {
  beforeEach(() => invokeMock.mockReset())
  afterEach(() => expect(getActiveOperationRequests()).toEqual([]))

  it('carries an explicit workflow identity into the actual IPC payload', async () => {
    const context = { requestId: 'request-workflow', workspaceKey: '/tmp/Repo ' }
    invokeMock.mockResolvedValueOnce({ status: 0 })
    await invokeLogged('lore_status', { repositoryPath: '/tmp/Repo ' }, context)
    expect(invokeMock.mock.calls[0]).toEqual([
      'lore_status',
      { repositoryPath: '/tmp/Repo ', operationContext: context }
    ])
  })

  it('keeps overlapping IPC calls attached to their own requests', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    invokeMock.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    const a = { requestId: 'request-a', workspaceKey: '/tmp/A' }
    const b = { requestId: 'request-b', workspaceKey: '/tmp/B' }
    const pendingA = invokeLogged('lore_status', { repositoryPath: '/tmp/A' }, a)
    const pendingB = invokeLogged('lore_status', { repositoryPath: '/tmp/B' }, b)
    expect(invokeMock.mock.calls.map(([, args]) => args.operationContext)).toEqual([a, b])
    expect(getActiveOperationRequests()).toEqual([a, b])
    second.resolve('b')
    expect(await pendingB).toBe('b')
    expect(getActiveOperationRequests()).toEqual([a])
    first.resolve('a')
    expect(await pendingA).toBe('a')
  })

  it('gives independent calls unique requests and preserves repository and global scope', async () => {
    invokeMock.mockResolvedValue(undefined)
    await invokeLogged('lore_status', { repositoryPath: '/tmp/Repo ' })
    await invokeLogged('lore_status', { repositoryPath: '/tmp/Repo ' })
    await invokeLogged('lore_device_list')
    const contexts = invokeMock.mock.calls.map(([, args]) => args.operationContext)
    expect(new Set(contexts.map((context) => context.requestId)).size).toBe(3)
    expect(contexts.map((context) => context.workspaceKey)).toEqual(['/tmp/Repo ', '/tmp/Repo ', null])
    expect(contexts.every((context) => typeof context.requestId === 'string' && context.requestId.length > 0)).toBe(
      true
    )
  })

  it('keeps the explicit owner when child parameters refer to a temporary repository', async () => {
    const context = createOperationContext('/tmp/Owner ')
    invokeMock.mockResolvedValue(undefined)
    await invokeLogged(
      'lore_status',
      { repositoryPath: '/tmp/temporary', operationContext: createOperationContext('/tmp/wrong-owner') },
      context
    )
    expect(invokeMock.mock.calls[0][1]).toEqual({
      repositoryPath: '/tmp/temporary',
      operationContext: context
    })
  })

  it('keeps the outer workflow active after its IPC child succeeds', async () => {
    const context = createOperationContext('/tmp/A')
    const events: string[] = []
    const unsubscribe = subscribeOperationRequests((event) => events.push(event.type))
    const finishRoot = acquireOperationRequest(context)
    try {
      invokeMock.mockResolvedValueOnce('done')
      await invokeLogged('lore_status', {}, context)
      expect(getActiveOperationRequests()).toEqual([context])
      expect(events).toEqual(['started'])
      finishRoot()
      expect(events).toEqual(['started', 'finished'])
    } finally {
      finishRoot()
      unsubscribe()
    }
  })

  it('releases its IPC lease when native execution rejects without replacing the error', async () => {
    const context = createOperationContext('/tmp/A')
    const failure = { code: 'heavy_read_superseded', message: 'newer request' }
    invokeMock.mockRejectedValueOnce(failure)
    await expect(invokeLogged('lore_status', {}, context)).rejects.toBe(failure)
    expect(getActiveOperationRequests()).toEqual([])
  })

  it('releases its IPC lease when invocation throws synchronously', async () => {
    const failure = new Error('webview unavailable')
    invokeMock.mockImplementationOnce(() => {
      throw failure
    })
    await expect(invokeLogged('lore_status')).rejects.toBe(failure)
    expect(getActiveOperationRequests()).toEqual([])
  })

  it('refuses conflicting ownership before invoking native code', async () => {
    const context = createOperationContext('/tmp/A')
    const finishRoot = acquireOperationRequest(context)
    try {
      await expect(invokeLogged('lore_status', {}, { ...context, workspaceKey: '/tmp/B' })).rejects.toThrow(
        'workspace owner'
      )
      expect(invokeMock).not.toHaveBeenCalled()
      expect(getActiveOperationRequests()).toEqual([context])
    } finally {
      finishRoot()
    }
  })

  it('passes explicit workflow ownership through both core command paths', async () => {
    const context = createOperationContext('/tmp/A')
    const result = { ...context, operation: 'status', status: 0, durationMs: 5, events: [] }
    invokeMock.mockResolvedValueOnce(result).mockResolvedValueOnce({ value: 7 })
    expect(await runOperation('lore_status', { repositoryPath: '/tmp/A' }, context)).toBe(result)
    expect(await invokeCommand('lore_read_dto', {}, context)).toEqual({ value: 7 })
    expect(invokeMock.mock.calls.map(([, args]) => args.operationContext)).toEqual([context, context])
  })
})
