import { beforeEach, describe, expect, it, vi } from 'bun:test'

const invokeMock = vi.fn()
const tauriCore = await import('@tauri-apps/api/core')
vi.mock('@tauri-apps/api/core', () => ({ ...tauriCore, invoke: invokeMock, isTauri: () => true }))
const { invokeLogged } = await import('./logging')

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('IPC operation ownership', () => {
  beforeEach(() => invokeMock.mockReset())

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
    second.resolve('b')
    expect(await pendingB).toBe('b')
    first.resolve('a')
    expect(await pendingA).toBe('a')
  })
})
