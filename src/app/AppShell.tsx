import { CheckCircle2, Info, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { RepositoryTabs } from '../features/repository-session'
import type { LoreRuntimeInfo, Repository, ResolvedTheme, ToastMessage } from '../types'
import { StatusBar } from './components/StatusBar'
import { TitleBar } from './components/TitleBar'
import { Toolbar } from './components/Toolbar'

interface AppShellProps {
  repository: Repository
  theme: ResolvedTheme
  operationCount: number
  repositories: Repository[]
  activeRepositoryId: string
  runtimeInfo: LoreRuntimeInfo | null
  busyLabel: string | null
  demoMode: boolean
  toast: ToastMessage | null
  onToolbarAction: (action: string) => void
  onToggleTheme: () => void
  onOpenCommands: () => void
  onSelectRepository: (repositoryId: string) => void
  onCloseRepository: (repositoryId: string) => void
  onReorderRepositories: (sourceRepositoryId: string, targetRepositoryId: string) => void
  onAddRepository: () => void
  onCloseToast: () => void
  children: ReactNode
  overlays: ReactNode
}

/**
 * 应用稳定外壳：标题栏、工具栏、仓库标签、工作区插槽、状态栏和全局 Overlay。
 *
 * 领域控制器不应依赖窗口框架；App 只把当前仓库和顶层动作交给外壳，再把具体工作区
 * 作为 children 注入。这样后续拆分工作区视图不会再次修改窗口级结构。
 */
export function AppShell({
  repository,
  theme,
  operationCount,
  repositories,
  activeRepositoryId,
  runtimeInfo,
  busyLabel,
  demoMode,
  toast,
  onToolbarAction,
  onToggleTheme,
  onOpenCommands,
  onSelectRepository,
  onCloseRepository,
  onReorderRepositories,
  onAddRepository,
  onCloseToast,
  children,
  overlays
}: AppShellProps) {
  const { t } = useTranslation()

  return (
    <div
      className="app-shell"
      onContextMenu={(event) => {
        // Lore 使用对象级自定义菜单；其余区域也必须抑制浏览器菜单，避免桌面壳露出网页语义。
        event.preventDefault()
      }}
    >
      <TitleBar
        repository={repository}
        theme={theme}
        operationCount={operationCount}
        onAction={onToolbarAction}
        onToggleTheme={onToggleTheme}
      />
      <Toolbar repository={repository} onAction={onToolbarAction} onOpenCommands={onOpenCommands} />
      <RepositoryTabs
        repositories={repositories}
        activeId={activeRepositoryId}
        onSelect={onSelectRepository}
        onClose={onCloseRepository}
        onReorder={onReorderRepositories}
        onAdd={onAddRepository}
      />

      {children}

      <StatusBar repository={repository} runtimeInfo={runtimeInfo} busyLabel={busyLabel} demoMode={demoMode} />
      {overlays}

      {toast && (
        <div className={`toast is-${toast.tone}`} role="status">
          <span>{toast.tone === 'success' ? <CheckCircle2 size={17} /> : <Info size={17} />}</span>
          <div>
            <strong>{toast.title}</strong>
            {/* 长错误允许在 Toast 内换行滚动；title 同时提供不受布局限制的悬停全文。 */}
            <small title={toast.detail}>{toast.detail}</small>
          </div>
          <button type="button" aria-label={t('closeNotification')} onClick={onCloseToast}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
