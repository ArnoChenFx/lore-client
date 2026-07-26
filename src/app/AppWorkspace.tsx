import type { ReactNode, RefObject } from 'react'

interface AppWorkspaceProps {
  workspaceRef: RefObject<HTMLElement | null>
  repositoryOpen: boolean
  sidebarWidth: number
  inspectorWidth: number
  inspectorVisible: boolean
  children: ReactNode
}

/**
 * 主工作区的稳定三栏组合。
 *
 * 这里统一拥有 Grid 列模板；侧栏、内容、分割线与 Inspector 仍由 App 作为一个明确的
 * 工作区插槽传入，后续拆分单个领域视图时无需再次触碰窗口外壳。
 */
export function AppWorkspace({
  workspaceRef,
  repositoryOpen,
  sidebarWidth,
  inspectorWidth,
  inspectorVisible,
  children
}: AppWorkspaceProps) {
  return (
    <main
      ref={workspaceRef}
      className="workspace"
      style={
        repositoryOpen
          ? {
              gridTemplateColumns: inspectorVisible
                ? `${sidebarWidth}px 5px minmax(340px, 1fr) 5px ${inspectorWidth}px`
                : `${sidebarWidth}px 5px minmax(340px, 1fr)`
            }
          : undefined
      }
    >
      {children}
    </main>
  )
}
