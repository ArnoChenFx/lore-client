import {
  ArrowUpFromLine,
  Boxes,
  CloudCog,
  Command,
  FolderOpen,
  GitBranch,
  Plus,
  RefreshCw,
  Search,
  Settings2
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { Repository } from '../../types'

interface ToolbarProps {
  repository: Repository
  onAction: (action: string) => void
  onOpenCommands: () => void
}

interface ToolbarAction {
  id: string
  label: string
  icon: typeof RefreshCw
  accent?: boolean
}

export function Toolbar({ repository, onAction, onOpenCommands }: ToolbarProps) {
  const { t } = useTranslation()
  // 工具栏标签必须在渲染期取 t()，避免模块导入时冻结为默认语言。
  const primaryActions: ToolbarAction[] = [
    { id: 'sync', label: t('sync'), icon: RefreshCw, accent: true },
    // { id: "hydrate", label: t('fetchContent'), icon: ArrowDownToLine },
    { id: 'push', label: t('push'), icon: ArrowUpFromLine },
    { id: 'revision', label: t('newRevision'), icon: Plus }
  ]
  return (
    <section className="toolbar" aria-label={t('repositoryToolbar')}>
      <div className="toolbar__group">
        {primaryActions.map((action) => {
          const ActionIcon = action.icon
          return (
            <button
              key={action.id}
              type="button"
              className={`toolbar-action ${action.accent ? 'is-accent' : ''}`}
              onClick={() => onAction(action.id)}
            >
              <ActionIcon size={18} strokeWidth={1.7} />
              <span>{action.label}</span>
            </button>
          )
        })}
      </div>

      <button
        type="button"
        className="repository-switcher"
        aria-label={t('switchCurrentRepository')}
        onClick={() => onAction('repository')}
      >
        <span className="repository-switcher__icon">
          <Boxes size={17} />
        </span>
        <span className="repository-switcher__copy">
          <strong>{repository.name}</strong>
          <small>
            <GitBranch size={11} />
            {repository.branch}
          </small>
        </span>
        <span className={`connection-pill ${repository.online ? 'is-online' : ''}`}>
          {repository.remoteState === 'online'
            ? t('online')
            : repository.remoteState === 'unauthorized'
              ? t('remoteAuthenticationRequired')
              : repository.remoteState === 'offline'
                ? t('offline')
                : t('localMode')}
        </span>
      </button>

      <div className="toolbar__group toolbar__group--end">
        <button
          type="button"
          className="toolbar-action toolbar-action--icon"
          onClick={() => onAction('open-workspace')}
          aria-label={t('openProjectDirectory')}
          title={t('openProjectDirectory')}
        >
          <FolderOpen size={18} strokeWidth={1.7} />
        </button>
        {/*<span className="toolbar__divider" />
        {secondaryActions.map((action) => {
          const ActionIcon = action.icon
          return (
            <button key={action.id} type="button" className="toolbar-action" onClick={() => onAction(action.id)}>
              <ActionIcon size={18} strokeWidth={1.7} />
              <span>{action.label}</span>
            </button>
          )
        })}*/}
        <span className="toolbar__divider" />
        <button
          type="button"
          className="toolbar-action toolbar-action--compact"
          onClick={onOpenCommands}
          title={t('openCommandPalette')}
        >
          <Command size={17} />
          <span>{t('command')}</span>
        </button>
        <button
          type="button"
          className="toolbar-action toolbar-action--icon"
          onClick={() => onAction('search')}
          aria-label={t('globalSearch')}
          title={t('globalSearch')}
        >
          <Search size={17} />
        </button>
        <button
          type="button"
          className="toolbar-action toolbar-action--icon"
          onClick={() => onAction('server')}
          aria-label={t('serverSettings')}
          title={t('serverSettings')}
        >
          <CloudCog size={18} />
        </button>
        <button
          type="button"
          className="toolbar-action toolbar-action--icon"
          onClick={() => onAction('settings')}
          aria-label={t('clientSettings')}
          title={t('clientSettings')}
        >
          <Settings2 size={18} />
        </button>
      </div>
    </section>
  )
}
