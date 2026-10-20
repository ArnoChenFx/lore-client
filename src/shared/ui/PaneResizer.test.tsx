import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'bun:test'

import { DEFAULT_WORKSPACE_LAYOUT, workspaceLayoutReducer } from '../../hooks/useWorkspaceLayout'

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
// Preserve values rather than Bun's live module namespace, which mock() rewrites.
const reactActual = { ...(await import('react')) }
const cleanups: (() => void)[] = []
vi.mock('react', () => ({
  ...reactActual,
  useRef: <T,>(initial: T) => ({ current: initial }),
  useEffect: (setup: () => () => void) => cleanups.push(setup())
}))

// restoreAllMocks() does not restore Bun module mocks.
afterAll(() => {
  vi.mock('react', () => reactActual)
})

const { PaneResizer } = await import('./PaneResizer')

function pointerEvent(type: string, clientX = 0, buttons = 1, pointerId = 1) {
  return Object.assign(new Event(type), { pointerId, clientX, buttons })
}

function mountResizer(
  onResize?: (value: number, containerWidth: number, commit?: boolean) => void,
  direction: 'right' | 'left' = 'right'
) {
  const onChange = vi.fn(onResize)
  const container = document.createElement('div')
  const target = Object.assign(new EventTarget(), {
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => true,
    releasePointerCapture: vi.fn()
  })
  const node = PaneResizer({
    label: 'Resize sidebar',
    value: direction === 'right' ? 244 : 520,
    direction,
    container,
    onChange,
    onReset: vi.fn()
  })
  node.props.onPointerDown({ button: 0, preventDefault: vi.fn(), clientX: 100, pointerId: 1, currentTarget: target })
  return { onChange, target, container }
}

describe('pane resize preference commits', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() })
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        body: { classList: { add: vi.fn(), remove: vi.fn() } },
        createElement: () => ({ clientWidth: 1600, isConnected: true })
      }
    })
  })

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  })

  it('previews each move and commits exactly once when the pointer is released', () => {
    const { onChange } = mountResizer()
    window.dispatchEvent(pointerEvent('pointermove', 120))
    window.dispatchEvent(pointerEvent('pointermove', 150))
    expect(onChange.mock.calls).toEqual([
      [264, 1600, false],
      [294, 1600, false]
    ])
    window.dispatchEvent(pointerEvent('pointerup'))
    window.dispatchEvent(pointerEvent('pointerup'))
    window.dispatchEvent(pointerEvent('pointermove', 200))
    expect(onChange.mock.calls).toEqual([
      [264, 1600, false],
      [294, 1600, false],
      [294, 1600, true]
    ])
  })

  for (const reason of ['pointercancel', 'blur', 'lostpointercapture', 'released-button', 'unmount']) {
    it(`commits the last valid preview on ${reason}`, () => {
      const { onChange, target } = mountResizer()
      window.dispatchEvent(pointerEvent('pointermove', 120))
      if (reason === 'lostpointercapture') target.dispatchEvent(pointerEvent(reason))
      else if (reason === 'released-button') window.dispatchEvent(pointerEvent('pointermove', 999, 0))
      else if (reason === 'unmount') cleanups.splice(0).forEach((cleanup) => cleanup())
      else window.dispatchEvent(pointerEvent(reason))
      expect(onChange.mock.calls).toEqual([
        [264, 1600, false],
        [264, 1600, true]
      ])
    })
  }

  for (const reason of ['pointerup', 'blur']) {
    for (const pane of [
      { direction: 'right', type: 'sidebar', clientX: 236, requestedWidth: 380 },
      { direction: 'left', type: 'inspector', clientX: -380, requestedWidth: 1000 }
    ] as const) {
      it(`preserves the fitted ${pane.type} bounds when the container shrinks before ${reason}`, () => {
        let state = { layout: DEFAULT_WORKSPACE_LAYOUT, committedLayout: DEFAULT_WORKSPACE_LAYOUT }
        const { onChange, container } = mountResizer((width, containerWidth, commit = true) => {
          state = workspaceLayoutReducer(state, { type: pane.type, width, containerWidth, commit })
        }, pane.direction)
        window.dispatchEvent(pointerEvent('pointermove', pane.clientX))

        Object.defineProperty(container, 'clientWidth', { value: 1000 })
        state = workspaceLayoutReducer(state, { type: 'fit', containerWidth: 1000 })
        const fitted = state.layout
        window.dispatchEvent(pointerEvent(reason))

        expect(onChange.mock.calls).toEqual([
          [pane.requestedWidth, 1600, false],
          [pane.requestedWidth, 1000, true]
        ])
        expect(state.layout).toBe(fitted)
        expect(state.committedLayout).toBe(fitted)
        expect(state.layout.sidebarWidth + state.layout.inspectorWidth + 340 + 10).toBeLessThanOrEqual(1000)
      })
    }
  }

  for (const isConnected of [true, false]) {
    it(`commits the last measured bounds when the ${isConnected ? 'connected' : 'removed'} container measures zero`, () => {
      const { onChange, container } = mountResizer()
      window.dispatchEvent(pointerEvent('pointermove', 120))
      Object.defineProperties(container, {
        clientWidth: { value: 0 },
        isConnected: { value: isConnected }
      })
      cleanups.splice(0).forEach((cleanup) => cleanup())
      expect(onChange.mock.calls).toEqual([
        [264, 1600, false],
        [264, 1600, true]
      ])
    })
  }

  it('ignores other pointers and a click with no movement', () => {
    const { onChange } = mountResizer()
    window.dispatchEvent(pointerEvent('pointermove', 150, 1, 2))
    window.dispatchEvent(pointerEvent('pointerup'))
    expect(onChange).not.toHaveBeenCalled()
  })
})
