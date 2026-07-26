import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'

interface PaneResizerProps {
  label: string
  value: number
  direction: 'right' | 'left'
  container: HTMLElement | null
  onChange: (nextValue: number, containerWidth: number) => void
  onReset: () => void
}

/*
 * 同一窗口任意时刻只能存在一个纵向分区拖动会话。这个模块级清理入口用于
 * 处理桌面 WebView 丢失 pointerup 后，用户又开始拖动另一条分割线的情况；
 * 若让两个 window.pointermove 监听器并存，它们会使用不同起点反复写宽度，
 * 表现为分割条抖动且松开鼠标后仍继续移动。
 */
let activePaneResizeCleanup: (() => void) | null = null

/**
 * 桌面分区分隔条。
 *
 * 鼠标拖拽使用 Pointer Events，因而同时兼容触控笔；键盘方向键每次移动
 * 12 像素，按住 Shift 时移动 36 像素，双击恢复默认布局。
 *
 * 分隔条本身只绘制一条主题基准线，不再挂载 Grip 图标。这样 hover
 * 仅改变线条颜色，不会在高密度桌面界面中突然出现额外的可见手柄。
 */
export function PaneResizer({ label, value, direction, container, onChange, onReset }: PaneResizerProps) {
  const localCleanupRef = useRef<(() => void) | null>(null)

  useEffect(
    () => () => {
      // 分割条随视图切换卸载时必须同步移除全局监听，避免幽灵拖动会话。
      localCleanupRef.current?.()
    },
    []
  )

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()

    // 新会话开始前先终止窗口中可能遗留的旧会话，保证全局监听器唯一。
    activePaneResizeCleanup?.()

    const startX = event.clientX
    const startValue = value
    const pointerId = event.pointerId
    const target = event.currentTarget
    let finished = false

    const finishResize = () => {
      if (finished) return
      finished = true

      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerEnd)
      window.removeEventListener('pointercancel', handlePointerEnd)
      window.removeEventListener('blur', finishResize)
      target.removeEventListener('lostpointercapture', handlePointerEnd)
      document.body.classList.remove('is-resizing-panes')

      /*
       * 先移除 lostpointercapture 监听再主动释放，避免释放动作再次进入清理。
       * hasPointerCapture 在 WebView 丢失捕获时会返回 false，此时无需额外操作。
       */
      if (target.hasPointerCapture(pointerId)) {
        target.releasePointerCapture(pointerId)
      }
      if (activePaneResizeCleanup === finishResize) {
        activePaneResizeCleanup = null
      }
      if (localCleanupRef.current === finishResize) {
        localCleanupRef.current = null
      }
    }

    const handlePointerEnd = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return
      finishResize()
    }

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return

      /*
       * Windows WebView 可能在重排、离开窗口或捕获变化时漏发 pointerup。
       * 后续移动事件已经没有主按钮时，把它视作释放并立即自愈，不能再改宽度。
       */
      if ((moveEvent.buttons & 1) === 0) {
        finishResize()
        return
      }
      if (!container) return
      const delta = moveEvent.clientX - startX
      const signedDelta = direction === 'right' ? delta : -delta
      onChange(startValue + signedDelta, container.clientWidth)
    }

    activePaneResizeCleanup = finishResize
    localCleanupRef.current = finishResize
    target.setPointerCapture(pointerId)
    document.body.classList.add('is-resizing-panes')

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerEnd)
    window.addEventListener('pointercancel', handlePointerEnd)
    window.addEventListener('blur', finishResize)
    target.addEventListener('lostpointercapture', handlePointerEnd)
  }

  return (
    <div
      className="pane-resizer"
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuenow={Math.round(value)}
      onPointerDown={startResize}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (!container || !['ArrowLeft', 'ArrowRight'].includes(event.key)) {
          return
        }
        event.preventDefault()
        const step = event.shiftKey ? 36 : 12
        const physicalDelta = event.key === 'ArrowRight' ? step : -step
        const signedDelta = direction === 'right' ? physicalDelta : -physicalDelta
        onChange(value + signedDelta, container.clientWidth)
      }}
    />
  )
}
