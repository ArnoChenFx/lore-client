import { useEffect, useRef } from 'react'

/**
 * 为临时浮层提供统一的关闭生命周期。
 *
 * `rootRef` 必须挂在同时包含入口按钮与浮层内容的控制区上。这样入口按钮再次点击
 * 和浮层内部编辑都被视为内部交互；点击控制区外、键盘焦点移到外部或按下 Escape
 * 才会触发关闭。指针监听使用捕获阶段，避免列表行等业务组件阻止冒泡后留下浮层。
 */
export function useDismissiblePopover<T extends HTMLElement>(open: boolean, onDismiss: () => void) {
  const rootRef = useRef<T>(null)
  const onDismissRef = useRef(onDismiss)

  /*
   * 关闭函数通常会在组件渲染时创建。通过 ref 保存最新实现，避免仅因函数引用变化
   * 重复拆装 document 监听，同时确保监听回调不会捕获过期状态。
   */
  useEffect(() => {
    onDismissRef.current = onDismiss
  }, [onDismiss])

  useEffect(() => {
    if (!open) return

    const isOutsideRoot = (target: EventTarget | null) => {
      const root = rootRef.current
      return Boolean(root && target instanceof Node && !root.contains(target))
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (isOutsideRoot(event.target)) onDismissRef.current()
    }
    const handleFocusIn = (event: FocusEvent) => {
      if (isOutsideRoot(event.target)) onDismissRef.current()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismissRef.current()
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('focusin', handleFocusIn, true)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('focusin', handleFocusIn, true)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return rootRef
}
