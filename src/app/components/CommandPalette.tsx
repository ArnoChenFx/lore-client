import {
  ArrowRight,
  ArrowUpFromLine,
  Command,
  FolderOpen,
  GitBranch,
  GitCompareArrows,
  History,
  Layers3,
  LockKeyhole,
  Network,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  CloudCog,
  Settings2,
  ShieldCheck,
  Clock3,
  UserRound
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface CommandPaletteProps {
  onClose: () => void
  onRun: (command: string) => void
}

export function CommandPalette({ onClose, onRun }: CommandPaletteProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const commands = useMemo(
    () => [
      { id: 'sync', label: t('syncCurrentRepository'), group: t('repository'), icon: RefreshCw },
      { id: 'push', label: t('pushCurrentBranch'), group: t('repository'), icon: ArrowUpFromLine },
      { id: 'open-workspace', label: t('openProjectDirectory'), group: t('repository'), icon: FolderOpen },
      { id: 'revision', label: t('createNewRevision'), group: t('workspace'), icon: Plus },
      { id: 'branch', label: t('switchBranch'), group: t('navigation'), icon: GitBranch },
      {
        id: 'view',
        label: t('editSelectiveSyncRules'),
        group: 'Lore',
        icon: SlidersHorizontal
      },
      { id: 'layers', label: t('manageLayers'), group: 'Lore', icon: Layers3 },
      { id: 'locks', label: t('manageCollaborativeLocks'), group: 'Lore', icon: LockKeyhole },
      { id: 'dependencies', label: t('manageFileDependencies'), group: 'Lore', icon: Network },
      { id: 'branch-collaboration', label: t('manageBranchCollaboration'), group: 'Lore', icon: GitCompareArrows },
      { id: 'revision-recovery', label: t('manageRevisionRecovery'), group: 'Lore', icon: History },
      { id: 'accounts', label: t('manageLoreAccounts'), group: 'Lore', icon: UserRound },
      { id: 'server', label: t('browseOrCloneRemoteRepositories'), group: 'Lore', icon: CloudCog },
      { id: 'verify', label: t('verifyCurrentRepository'), group: t('maintenance'), icon: ShieldCheck },
      { id: 'search', label: t('searchCurrentRepository'), group: t('navigation'), icon: Search },
      { id: 'operations', label: t('viewOperationHistory'), group: t('client'), icon: Clock3 },
      { id: 'settings', label: t('openClientSettings'), group: t('client'), icon: Settings2 }
    ],
    [t]
  )
  const filteredCommands = useMemo(
    () =>
      commands.filter((command) =>
        `${command.group} ${command.label}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())
      ),
    [commands, query]
  )
  useEffect(() => setSelectedIndex(0), [query])

  const runSelected = () => {
    const command = filteredCommands[selectedIndex]
    if (!command) return
    onRun(command.id)
    onClose()
  }

  return (
    <div className="command-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label={t('commandPalette')}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="composite-input">
          <Command size={16} />
          <Search size={14} />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('typeACommandOrSearchActions')}
            aria-label={t('searchCommands')}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setSelectedIndex((index) => Math.min(index + 1, filteredCommands.length - 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setSelectedIndex((index) => Math.max(index - 1, 0))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                runSelected()
              } else if (event.key === 'Escape') {
                onClose()
              }
            }}
          />
        </header>
        <div className="command-list">
          {filteredCommands.map((command, index) => {
            const CommandIcon = command.icon
            return (
              <button
                key={command.id}
                type="button"
                className={index === selectedIndex ? 'is-highlighted' : ''}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => {
                  onRun(command.id)
                  onClose()
                }}
              >
                <span className="command-list__icon">
                  <CommandIcon size={15} />
                </span>
                <span>
                  <strong>{command.label}</strong>
                  <small>{command.group}</small>
                </span>
                <ArrowRight size={13} />
              </button>
            )
          })}
          {filteredCommands.length === 0 && <div className="command-list__empty">{t('noMatchingCommands')}</div>}
        </div>
        <footer>
          <span>{t('choose')}</span>
          <span>{t('run')}</span>
          <b>Lore Command Surface</b>
        </footer>
      </section>
    </div>
  )
}
