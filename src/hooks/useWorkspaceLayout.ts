import { useCallback, useEffect, useState } from 'react'

import type { WorkspaceLayout } from '../types'
import { useClientPreferences } from './useClientPreferences'

export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayout = {
  sidebarWidth: 244,
  inspectorWidth: 520
}
const SIDEBAR_MIN = 190
const SIDEBAR_MAX = 390
const INSPECTOR_MIN = 340
const CONTENT_MIN = 340
const RESIZER_TOTAL = 10
const WORKSPACE_FRAME = 2

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
}

/**
 * 首次渲染时工作区节点尚未挂载，使用视口宽度扣除应用外框估算可用宽度。
 * 后续真实拖拽仍由 PaneResizer 传入 workspace.clientWidth，不依赖该估算。
 */
function readInitialContainerWidth(): number {
  if (typeof document === 'undefined') {
    return DEFAULT_WORKSPACE_LAYOUT.sidebarWidth + DEFAULT_WORKSPACE_LAYOUT.inspectorWidth + CONTENT_MIN + RESIZER_TOTAL
  }
  return Math.max(0, document.documentElement.clientWidth - WORKSPACE_FRAME)
}

/**
 * 将已保存布局重新放进当前窗口。
 *
 * Inspector 不再使用固定像素最大值；它可以占用除侧栏、中栏最低宽度和
 * 分割线之外的全部空间。窗口缩小时先保证两侧面板的最小宽度，再收缩保存值。
 */
function fitLayoutToContainer(layout: WorkspaceLayout, containerWidth: number): WorkspaceLayout {
  const sidebarMaximum = Math.min(SIDEBAR_MAX, containerWidth - INSPECTOR_MIN - CONTENT_MIN - RESIZER_TOTAL)
  const sidebarWidth = clamp(layout.sidebarWidth, SIDEBAR_MIN, sidebarMaximum)
  const inspectorMaximum = containerWidth - sidebarWidth - CONTENT_MIN - RESIZER_TOTAL

  return {
    sidebarWidth,
    inspectorWidth: clamp(layout.inspectorWidth, INSPECTOR_MIN, inspectorMaximum)
  }
}

/**
 * 管理三栏工作区尺寸，并在窗口变窄时始终给中间内容保留最低空间。
 */
export function useWorkspaceLayout() {
  const { preferences, ready, update } = useClientPreferences()
  /*
   * 原生偏好文件是启动快照，不是布局拖动期间的第二个实时状态源。
   *
   * Tauri 初始化完成前这里为 false；完成后只把磁盘值灌入一次。若持续监听
   * preferences.workspaceLayout，每次拖动都会形成
   * “本地布局 → 全局偏好 → 重新夹紧本地布局”的双向更新环。两次夹紧所处的
   * 渲染时机不同，分割条到达最小/最大宽度时便可能在相邻边界值间反复覆盖。
   */
  const [hydrated, setHydrated] = useState(ready)
  const [layout, setLayout] = useState<WorkspaceLayout>(() =>
    fitLayoutToContainer(preferences.workspaceLayout, readInitialContainerWidth())
  )

  /*
   * 偏好就绪后把磁盘值灌入一次。水合通常发生在挂载之后（偏好文件异步读取完成），
   * 此时 .workspace 已挂载，优先读取真实宽度与原 effect 语义一致；无 DOM 环境或
   * 节点缺失时回退到视口估算，由下方挂载时的 resize 校正兜底。
   */
  if (ready && !hydrated) {
    setHydrated(true)
    setLayout(
      fitLayoutToContainer(
        preferences.workspaceLayout,
        typeof document === 'undefined'
          ? readInitialContainerWidth()
          : (document.querySelector<HTMLElement>('.workspace')?.clientWidth ?? readInitialContainerWidth())
      )
    )
  }

  useEffect(() => {
    // 水合前不能把内存默认值写回磁盘，否则会覆盖尚未读取完成的用户布局。
    if (ready && hydrated) update({ workspaceLayout: layout })
  }, [hydrated, layout, ready, update])

  useEffect(() => {
    /**
     * 大窗口中保存的 Inspector 宽度在窗口缩小时必须重新适配。
     * 这里优先读取真实 workspace 宽度，节点尚未出现时再回退到视口估算。
     */
    const fitToWindow = () => {
      const containerWidth =
        document.querySelector<HTMLElement>('.workspace')?.clientWidth ?? readInitialContainerWidth()
      setLayout((current) => {
        const fitted = fitLayoutToContainer(current, containerWidth)
        return fitted.sidebarWidth === current.sidebarWidth && fitted.inspectorWidth === current.inspectorWidth
          ? current
          : fitted
      })
    }

    fitToWindow()
    window.addEventListener('resize', fitToWindow)
    return () => window.removeEventListener('resize', fitToWindow)
  }, [])

  const resizeSidebar = useCallback((nextWidth: number, containerWidth: number) => {
    setLayout((current) => {
      const sidebarWidth = clamp(
        nextWidth,
        SIDEBAR_MIN,
        Math.min(SIDEBAR_MAX, containerWidth - current.inspectorWidth - CONTENT_MIN - RESIZER_TOTAL)
      )
      // 指针压在边界外时会持续产生 pointermove；相同值必须复用原状态，
      // 不能让无效事件继续触发偏好写入和全局订阅者重渲染。
      return sidebarWidth === current.sidebarWidth ? current : { ...current, sidebarWidth }
    })
  }, [])

  const resizeInspector = useCallback((nextWidth: number, containerWidth: number) => {
    setLayout((current) => {
      const inspectorWidth = clamp(
        nextWidth,
        INSPECTOR_MIN,
        containerWidth - current.sidebarWidth - CONTENT_MIN - RESIZER_TOTAL
      )
      return inspectorWidth === current.inspectorWidth ? current : { ...current, inspectorWidth }
    })
  }, [])

  const resetLayout = useCallback(() => {
    const containerWidth = document.querySelector<HTMLElement>('.workspace')?.clientWidth ?? readInitialContainerWidth()
    setLayout((current) => {
      const next = fitLayoutToContainer(DEFAULT_WORKSPACE_LAYOUT, containerWidth)
      return next.sidebarWidth === current.sidebarWidth && next.inspectorWidth === current.inspectorWidth
        ? current
        : next
    })
  }, [])

  return {
    layout,
    resizeSidebar,
    resizeInspector,
    resetLayout
  }
}
