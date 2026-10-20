import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'bun:test'

import type { ReactElement } from 'react'

import { t } from '../../i18n'
import type { LoreOperationResult, LoreSharedStoreInfo, LoreSharedStoreRegistry } from '../../types'

type EffectSlot = { kind: 'effect'; dependencies?: readonly unknown[]; cleanup?: () => void }
interface HookState {
  cursor: number
  slots: unknown[]
  effects: (() => void)[]
  mounted: boolean
  writesAfterUnmount: number
}
let currentHooks: HookState
const reactActual = { ...(await import('react')) }
const translationActual = { ...(await import('react-i18next')) }
const loreActual = { ...(await import('../../services/lore')) }
const readInfo = vi.fn<() => Promise<LoreSharedStoreInfo>>()
const readRegistry = vi.fn<(includeInstances: boolean) => Promise<LoreSharedStoreRegistry>>()
const createStore = vi.fn<() => Promise<LoreOperationResult>>()
const setAutomatic = vi.fn<() => Promise<LoreOperationResult>>()
const sameDependencies = (a?: readonly unknown[], b?: readonly unknown[]) =>
  a !== undefined && b !== undefined && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))

vi.mock('react', () => ({
  ...reactActual,
  useState: <T,>(initial: T | (() => T)) => {
    const hooks = currentHooks
    const index = hooks.cursor++
    if (!(index in hooks.slots)) {
      hooks.slots[index] = typeof initial === 'function' ? (initial as () => T)() : initial
    }
    return [
      hooks.slots[index] as T,
      (value: T | ((previous: T) => T)) => {
        if (!hooks.mounted) hooks.writesAfterUnmount += 1
        hooks.slots[index] =
          typeof value === 'function' ? (value as (previous: T) => T)(hooks.slots[index] as T) : value
      }
    ]
  },
  useRef: <T,>(initial: T) => {
    const hooks = currentHooks
    const index = hooks.cursor++
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial }
    return hooks.slots[index] as { current: T }
  },
  useCallback: <T,>(callback: T, dependencies: readonly unknown[]) => {
    const hooks = currentHooks
    const index = hooks.cursor++
    const previous = hooks.slots[index] as { dependencies: readonly unknown[]; callback: T } | undefined
    if (!sameDependencies(previous?.dependencies, dependencies)) hooks.slots[index] = { dependencies, callback }
    return (hooks.slots[index] as { callback: T }).callback
  },
  useEffect: (effect: () => void | (() => void), dependencies?: readonly unknown[]) => {
    const hooks = currentHooks
    const index = hooks.cursor++
    const previous = hooks.slots[index] as EffectSlot | undefined
    if (sameDependencies(previous?.dependencies, dependencies)) return
    hooks.effects.push(() => {
      previous?.cleanup?.()
      hooks.slots[index] = { kind: 'effect', dependencies, cleanup: effect() }
    })
  }
}))
vi.mock('react-i18next', () => ({ ...translationActual, useTranslation: () => ({ t }) }))
vi.mock('../../services/lore', () => ({
  ...loreActual,
  loadSharedStoreInfo: readInfo,
  loadSharedStoreRegistry: readRegistry,
  createSharedStore: createStore,
  setSharedStoreUseAutomatically: setAutomatic
}))

const { useSharedStoreController } = await import('../../features/repository-session')
const { SettingsDialog } = await import('./SettingsDialog')
const mountedHarnesses: Array<() => void> = []

function harness<T>(renderHook: () => T) {
  const hooks: HookState = { cursor: 0, slots: [], effects: [], mounted: true, writesAfterUnmount: 0 }
  const render = () => {
    currentHooks = hooks
    hooks.cursor = 0
    return renderHook()
  }
  const flushEffects = () => {
    for (const effect of hooks.effects.splice(0)) effect()
  }
  const unmount = () => {
    if (!hooks.mounted) return
    for (const slot of hooks.slots) {
      if (slot && typeof slot === 'object' && 'kind' in slot && slot.kind === 'effect') {
        ;(slot as EffectSlot).cleanup?.()
      }
    }
    hooks.mounted = false
  }
  mountedHarnesses.push(unmount)
  return { render, flushEffects, unmount, hooks }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

function info(useAutomatically: boolean): LoreSharedStoreInfo {
  return { useAutomatically, stores: [], totalSizeBytes: 0, exactSavingsAvailable: false }
}

function registry(instancesRequested: boolean): LoreSharedStoreRegistry {
  return { instancesRequested, stores: [] }
}

function fixture() {
  const beginOperation = vi.fn(() => ({ id: 1, startedAt: 1 }))
  const finishOperation = vi.fn()
  const notify = vi.fn()
  const component = harness(() =>
    useSharedStoreController({ applicationMode: 'tauri', beginOperation, finishOperation, notify })
  )
  component.render()
  component.flushEffects()
  return { ...component, beginOperation, finishOperation, notify }
}

function findElement(node: unknown, id: string): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, id)
      if (found) return found
    }
  }
  if (!node || typeof node !== 'object' || !('props' in node)) return undefined
  const element = node as ReactElement<Record<string, unknown>>
  return element.props.id === id ? element : findElement(element.props.children, id)
}

async function tick() {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  readInfo.mockReset().mockResolvedValue(info(false))
  readRegistry.mockReset().mockResolvedValue(registry(false))
  const result: LoreOperationResult = { operation: 'shared_store.update', status: 0, durationMs: 1, events: [] }
  createStore.mockReset().mockResolvedValue(result)
  setAutomatic.mockReset().mockResolvedValue(result)
})
afterEach(() => {
  for (const unmount of mountedHarnesses.splice(0)) unmount()
})
afterAll(() => {
  vi.mock('react', () => reactActual)
  vi.mock('react-i18next', () => translationActual)
  vi.mock('../../services/lore', () => loreActual)
})

describe('Shared Store request ownership', () => {
  it('does not let an older refresh overwrite a newer snapshot or error', async () => {
    const older = deferred<LoreSharedStoreInfo>()
    const newer = deferred<LoreSharedStoreInfo>()
    readInfo.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const controller = fixture()
    const first = controller.render().refresh()
    await tick()
    const second = controller.render().refresh()
    await tick()
    newer.resolve(info(true))
    await second
    older.resolve(info(false))
    await first
    expect(controller.render().info?.useAutomatically).toBe(true)
    expect(controller.render().error).toBeNull()
  })

  it('does not clear the current refresh loading state when an old request fails', async () => {
    const older = deferred<LoreSharedStoreInfo>()
    const newer = deferred<LoreSharedStoreInfo>()
    readInfo.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const controller = fixture()
    const first = controller.render().refresh()
    await tick()
    const second = controller.render().refresh()
    await tick()
    older.reject(new Error('obsolete read'))
    await first
    expect(controller.render().loading).toBe(true)
    expect(controller.render().error).toBeNull()
    newer.resolve(info(true))
    await second
    expect(controller.render().loading).toBe(false)
  })

  it('keeps the latest read failure visible when an old successful read arrives later', async () => {
    const older = deferred<LoreSharedStoreInfo>()
    readInfo.mockReturnValueOnce(older.promise).mockRejectedValueOnce(new Error('current read failed'))
    const controller = fixture()
    const first = controller.render().refresh()
    await tick()
    await controller.render().refresh()
    older.resolve(info(false))
    await first
    expect(controller.render().info).toBeNull()
    expect(controller.render().error).toBe('current read failed')
  })

  it('invalidates pre-write reads and keeps the authoritative post-write snapshot', async () => {
    const oldInfo = deferred<LoreSharedStoreInfo>()
    const oldRegistry = deferred<LoreSharedStoreRegistry>()
    readInfo.mockReturnValueOnce(oldInfo.promise).mockResolvedValueOnce(info(true))
    readRegistry.mockReturnValueOnce(oldRegistry.promise)
    const controller = fixture()
    const staleInfo = controller.render().refresh()
    const staleRegistry = controller.render().loadRegistry()
    await tick()
    await controller.render().setAutomatic(true)
    expect(controller.render().info?.useAutomatically).toBe(true)
    oldInfo.resolve(info(false))
    oldRegistry.resolve(registry(false))
    await Promise.all([staleInfo, staleRegistry])
    expect(controller.render().info?.useAutomatically).toBe(true)
    expect(controller.render().registry).toBeNull()
    expect(controller.render().registryBusy).toBe(false)
  })

  it('prevents overlapping writes and registry scans before React rerenders the disabled controls', async () => {
    const write = deferred<LoreOperationResult>()
    setAutomatic.mockReturnValueOnce(write.promise)
    const controller = fixture()
    const actions = controller.render()
    const first = actions.setAutomatic(true)
    const duplicate = actions.create('lore://example.com', '')
    await actions.loadRegistry()
    await actions.refresh()
    expect(setAutomatic).toHaveBeenCalledTimes(1)
    expect(createStore).not.toHaveBeenCalled()
    expect(readRegistry).not.toHaveBeenCalled()
    expect(readInfo).not.toHaveBeenCalled()
    expect(controller.beginOperation).toHaveBeenCalledTimes(1)
    write.resolve({ operation: 'shared_store.update', status: 0, durationMs: 1, events: [] })
    await Promise.all([first, duplicate])
    expect(controller.render().busy).toBe(false)
  })

  it('releases the write latch after failure without allowing pre-write reads to replace the error', async () => {
    const older = deferred<LoreSharedStoreInfo>()
    readInfo.mockReturnValueOnce(older.promise).mockResolvedValueOnce(info(true))
    createStore.mockRejectedValueOnce(new Error('create failed'))
    const controller = fixture()
    const first = controller.render().refresh()
    await tick()
    await controller.render().create('lore://example.com', '')
    older.reject(new Error('obsolete read failed'))
    await first
    expect(controller.render().error).toBe('create failed')
    expect(controller.render().busy).toBe(false)
    expect(controller.finishOperation).toHaveBeenCalledWith(expect.anything(), false, 'create failed')
    await controller.render().setAutomatic(true)
    expect(controller.render().info?.useAutomatically).toBe(true)
    expect(controller.render().error).toBeNull()
  })

  it('binds registry loading and failures to the newest requested query', async () => {
    const older = deferred<LoreSharedStoreRegistry>()
    const newer = deferred<LoreSharedStoreRegistry>()
    readRegistry.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const controller = fixture()
    const first = controller.render().loadRegistry()
    const second = controller.render().loadRegistry()
    older.reject(new Error('obsolete registry'))
    await first
    expect(controller.render().registryBusy).toBe(true)
    expect(controller.render().registryError).toBeNull()
    newer.resolve(registry(false))
    await second
    expect(controller.render().registryBusy).toBe(false)
  })

  it('invalidates registry data when the instance-query option changes', async () => {
    const older = deferred<LoreSharedStoreRegistry>()
    readRegistry.mockReturnValueOnce(older.promise).mockResolvedValueOnce(registry(true))
    const controller = fixture()
    const actions = controller.render()
    const first = actions.loadRegistry()
    actions.setListInstances(true)
    expect(controller.render().registryBusy).toBe(false)
    await actions.loadRegistry()
    older.resolve(registry(false))
    await first
    expect(readRegistry.mock.calls).toEqual([[false], [true]])
    expect(controller.render().registry?.instancesRequested).toBe(true)
    controller.render().setListInstances(false)
    expect(controller.render().registry).toBeNull()
  })

  it('does not publish late read state after the shared controller unmounts', async () => {
    const pendingInfo = deferred<LoreSharedStoreInfo>()
    const pendingRegistry = deferred<LoreSharedStoreRegistry>()
    readInfo.mockReturnValueOnce(pendingInfo.promise)
    readRegistry.mockReturnValueOnce(pendingRegistry.promise)
    const controller = fixture()
    const first = controller.render().refresh()
    const second = controller.render().loadRegistry()
    await tick()
    controller.unmount()
    pendingInfo.resolve(info(true))
    pendingRegistry.reject(new Error('late registry'))
    await Promise.all([first, second])
    expect(controller.hooks.writesAfterUnmount).toBe(0)
  })

  it('does not start a post-write scan or publish notifications after the controller unmounts', async () => {
    const write = deferred<LoreOperationResult>()
    createStore.mockReturnValueOnce(write.promise)
    const controller = fixture()
    const task = controller.render().create('lore://example.com', '')
    controller.unmount()
    write.resolve({ operation: 'shared_store.create', status: 0, durationMs: 1, events: [] })
    await task
    expect(readInfo).not.toHaveBeenCalled()
    expect(controller.finishOperation).not.toHaveBeenCalled()
    expect(controller.notify).not.toHaveBeenCalled()
    expect(controller.hooks.writesAfterUnmount).toBe(0)
  })
})

describe('Settings storage category loading', () => {
  function settings(onRefreshSharedStores: () => void, initialCategory: 'general' | 'storage' = 'general') {
    return harness(() =>
      SettingsDialog({
        preference: 'system',
        language: 'en-US',
        defaultIdentity: '',
        initialCategory,
        onPreferenceChange: () => undefined,
        onLanguageChange: () => undefined,
        onDefaultIdentityChange: () => undefined,
        onResetLayout: () => undefined,
        onClose: () => undefined,
        onRefreshSharedStores
      })
    )
  }

  it('loads only when storage becomes active and does not repeat on ordinary rerenders', async () => {
    const refresh = vi.fn()
    const dialog = settings(refresh)
    let tree = dialog.render()
    dialog.flushEffects()
    await tick()
    expect(refresh).not.toHaveBeenCalled()
    const activate = (id: string) => {
      const tab = findElement(tree, `settings-tab-${id}`)
      expect(tab).toBeDefined()
      ;(tab!.props.onClick as () => void)()
      tree = dialog.render()
      dialog.flushEffects()
    }
    activate('identity')
    await tick()
    expect(refresh).not.toHaveBeenCalled()
    activate('storage')
    await tick()
    expect(refresh).toHaveBeenCalledTimes(1)
    tree = dialog.render()
    dialog.flushEffects()
    await tick()
    expect(refresh).toHaveBeenCalledTimes(1)
    activate('general')
    activate('storage')
    await tick()
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('does not start a scan if storage closes before its scheduled refresh', async () => {
    const refresh = vi.fn()
    const dialog = settings(refresh, 'storage')
    dialog.render()
    dialog.flushEffects()
    dialog.unmount()
    await tick()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('loads once when opening directly into storage and preserves the stable refresh callback', async () => {
    const controller = fixture()
    const refresh = controller.render().refresh
    const dialog = settings(refresh, 'storage')
    dialog.render()
    dialog.flushEffects()
    await tick()
    expect(readInfo).toHaveBeenCalledTimes(1)
    expect(controller.render().refresh).toBe(refresh)
    dialog.render()
    dialog.flushEffects()
    await tick()
    expect(readInfo).toHaveBeenCalledTimes(1)
  })

  it('keeps a Clone refresh alive when the Settings dialog closes', async () => {
    const pending = deferred<LoreSharedStoreInfo>()
    readInfo.mockReturnValueOnce(pending.promise)
    const controller = fixture()
    const dialog = settings(controller.render().refresh)
    dialog.render()
    dialog.flushEffects()
    const cloneRefresh = controller.render().refresh()
    await tick()
    dialog.unmount()
    pending.resolve(info(true))
    await cloneRefresh
    expect(controller.render().info?.useAutomatically).toBe(true)
  })
})
