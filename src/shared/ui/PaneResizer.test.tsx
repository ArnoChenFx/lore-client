import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test'

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
const reactActual = await import('react')
const cleanups: (() => void)[] = []
vi.mock('react', () => ({
  ...reactActual,
  useRef: <T,>(initial: T) => ({ current: initial }),
  useEffect: (setup: () => () => void) => cleanups.push(setup())
}))

const { PaneResizer } = await import('./PaneResizer')

function pointerEvent(type: string, clientX = 0, buttons = 1, pointerId = 1) {
  return Object.assign(new Event(type), { pointerId, clientX, buttons })
}

function mountResizer() {
  const onChange = vi.fn()
  const container = document.createElement('div')
  const target = Object.assign(new EventTarget(), {
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => true,
    releasePointerCapture: vi.fn()
  })
  const node = PaneResizer({
    label: 'Resize sidebar',
    value: 244,
    direction: 'right',
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
        createElement: () => ({ clientWidth: 1600 })
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

  it('commits the last measured bounds if the container was removed before cleanup', () => {
    const { onChange, container } = mountResizer()
    window.dispatchEvent(pointerEvent('pointermove', 120))
    Object.defineProperty(container, 'clientWidth', { value: 0 })
    cleanups.splice(0).forEach((cleanup) => cleanup())
    expect(onChange.mock.calls).toEqual([
      [264, 1600, false],
      [264, 1600, true]
    ])
  })

  it('ignores other pointers and a click with no movement', () => {
    const { onChange } = mountResizer()
    window.dispatchEvent(pointerEvent('pointermove', 150, 1, 2))
    window.dispatchEvent(pointerEvent('pointerup'))
    expect(onChange).not.toHaveBeenCalled()
  })
})
