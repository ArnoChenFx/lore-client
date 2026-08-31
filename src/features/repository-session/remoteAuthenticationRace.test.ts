import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RepositorySnapshot } from '../../types'

/*
 * 服务替身通过 Hook 的 dependencies 注入，而不是 vi.mock 整个 services 模块：
 * Bun test 在部分平台上会把模块级 mock 泄漏到其他测试文件，导致那里的
 * isAuthenticationRequiredError 恒为注入值并产生跨文件假失败。
 */
const serviceMocks = {
  listAuthIdentities: vi.fn(),
  listRemoteRepositories: vi.fn(),
  loadRepositorySnapshot: vi.fn(),
  loginAuthInteractive: vi.fn(),
  refreshRepositoryAuthenticationContexts: vi.fn(),
  subscribeRemoteAuthenticationRequired: vi.fn(() => Promise.resolve(() => undefined))
}

const hookState = {
  cursor: 0,
  values: [] as unknown[]
}
const reactActual = await import('react')

vi.mock('react', () => ({
  ...reactActual,
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
  /** 副作用在无真实挂载的 Hook 调用容器里不可执行，直接跳过。 */
  useEffect: () => undefined,
  useRef: <T>(initial: T) => {
    const index = hookState.cursor
    hookState.cursor += 1
    if (hookState.values.length <= index) {
      hookState.values[index] = { current: initial }
    }
    return hookState.values[index] as { current: T }
  },
  useState: <T>(initial: T | (() => T)) => {
    const index = hookState.cursor
    hookState.cursor += 1
    if (hookState.values.length <= index) {
      hookState.values[index] = typeof initial === 'function' ? (initial as () => T)() : initial
    }
    const setValue = (next: T | ((current: T) => T)) => {
      const current = hookState.values[index] as T
      hookState.values[index] = typeof next === 'function' ? (next as (value: T) => T)(current) : next
    }
    return [hookState.values[index] as T, setValue] as const
  }
}))

const { useRemoteAuthenticationRecovery } = await import('./remoteAuthentication')

function createSnapshot(remoteState: 'unauthorized' | 'online'): RepositorySnapshot {
  return {
    repository: {
      id: 'repository-1',
      name: 'alpha',
      branch: 'main',
      revision: 'revision-1',
      path: 'E:\\alpha',
      ahead: 0,
      behind: 0,
      online: remoteState === 'online',
      remoteState,
      color: '#78a4ff',
      remoteUrl: 'lore://server:41337/alpha',
      serverUrl: 'lore://server:41337',
      conflictCount: 0,
      unresolvedConflictCount: 0
    },
    branches: [],
    revisions: [],
    changes: [],
    tags: [],
    conflictSession: null,
    loadedAt: '2026-07-28T00:00:00.000Z'
  }
}

describe('remote authentication refresh timing', () => {
  beforeEach(() => {
    hookState.cursor = 0
    hookState.values = []
    vi.clearAllMocks()
  })

  it('keeps the recovery dialog suppressed while an account-page refresh is pending', async () => {
    let snapshots = [createSnapshot('unauthorized')]
    let releaseRefresh: (() => void) | undefined
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    serviceMocks.refreshRepositoryAuthenticationContexts.mockReturnValueOnce(refreshGate)
    serviceMocks.loadRepositorySnapshot.mockResolvedValueOnce(createSnapshot('online'))

    const renderRecovery = () => {
      hookState.cursor = 0
      return useRemoteAuthenticationRecovery({
        applicationMode: 'tauri',
        snapshots,
        upsertSnapshot: (snapshot) => {
          snapshots = [snapshot]
        },
        onEnterOfflineMode: vi.fn(),
        dependencies: serviceMocks
      })
    }

    const initial = renderRecovery()
    initial.continueOffline()
    expect(renderRecovery().authenticationTarget).toBeNull()

    const refreshPromise = renderRecovery().refreshAuthenticationState('lore://server:41337')
    await Promise.resolve()

    // 原生连接仍在刷新时，旧 unauthorized 快照不得重新打开恢复弹窗。
    expect(renderRecovery().authenticationTarget).toBeNull()

    releaseRefresh?.()
    await refreshPromise
    expect(renderRecovery().authenticationTarget).toBeNull()
  })
})
