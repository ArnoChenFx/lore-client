import {
  Boxes,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Database,
  FileClock,
  FileStack,
  GitBranch,
  History,
  Search,
  Settings2,
  SlidersHorizontal,
  Tags,
  UserRound
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { ContextMenuPoint } from '../../shared/ui'
import type { Branch, LoreTag, NavigationView, Repository } from '../../types'

interface SidebarProps {
  repository: Repository
  branches: Branch[]
  tags: LoreTag[]
  demoMode: boolean
  activeView: NavigationView
  selectedBranchId: string
  selectedTagId: string
  changeCount: number
  onViewChange: (view: NavigationView) => void
  onBranchSelect: (branch: Branch) => void
  onBranchCheckout: (branch: Branch) => void
  onBranchContextMenu: (branch: Branch, point: ContextMenuPoint) => void
  onTagSelect: (tag: LoreTag) => void
  onTagLocateRevision: (tag: LoreTag) => void
  onTagContextMenu: (tag: LoreTag, point: ContextMenuPoint) => void
  onOpenOperations: () => void
  onOpenServer: () => void
  onOpenConfiguration: () => void
  onOpenAccounts: () => void
  onOpenRepositoryTools: () => void
}

function SidebarSection({ title, children }: { title: string; children: React.ReactNode }) {
  // 每个一级分组维护自己的折叠状态，避免收起“分支”时影响 Lore 工具组。
  const [expanded, setExpanded] = useState(true)
  return (
    <section className="sidebar-section">
      <button
        type="button"
        className="sidebar-section__title"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{title}</span>
      </button>
      {expanded && <div className="sidebar-section__content">{children}</div>}
    </section>
  )
}

/**
 * 使用 Lore 返回的对象语义建立互斥分组。
 *
 * 已归档条目仍然属于本地元数据，但不能混入可检出的本地分支，否则双击和
 * 右键菜单会向已经归档的指针发送无效写操作。筛选条件对三个分组保持一致。
 */
export function groupSidebarBranches(branches: Branch[], branchFilter: string) {
  const normalizedFilter = branchFilter.toLocaleLowerCase()
  const visibleBranches = branches.filter((branch) => branch.name.toLocaleLowerCase().includes(normalizedFilter))

  return {
    localBranches: visibleBranches.filter((branch) => !branch.remote && !branch.archived),
    remoteBranches: visibleBranches.filter((branch) => branch.remote && !branch.archived),
    archivedBranches: visibleBranches.filter((branch) => branch.archived)
  }
}

export function Sidebar({
  repository,
  branches,
  tags,
  demoMode,
  activeView,
  selectedBranchId,
  selectedTagId,
  changeCount,
  onViewChange,
  onBranchSelect,
  onBranchCheckout,
  onBranchContextMenu,
  onTagSelect,
  onTagLocateRevision,
  onTagContextMenu,
  onOpenOperations,
  onOpenServer,
  onOpenConfiguration,
  onOpenAccounts,
  onOpenRepositoryTools
}: SidebarProps) {
  const { t } = useTranslation()
  // 分支筛选只影响侧栏投影，不参与仓库查询或其他工作区，因此由侧栏自行持有。
  const [branchFilter, setBranchFilter] = useState('')
  const { localBranches, remoteBranches, archivedBranches } = groupSidebarBranches(branches, branchFilter)
  const instanceLabel = demoMode ? '019c•••f18a' : t('localClient')
  const partitionLabel = demoMode ? 'meridian-prod' : t('default')
  // 二级分组独立控制，折叠只隐藏行，不改变筛选结果和当前 Branch 选区。
  const [localExpanded, setLocalExpanded] = useState(true)
  const [remoteExpanded, setRemoteExpanded] = useState(true)
  const [archivedExpanded, setArchivedExpanded] = useState(false)

  return (
    <aside className="sidebar">
      <div className="sidebar__repo-heading">
        <span className="sidebar__repo-mark">
          <Boxes size={16} />
        </span>
        <div>
          <strong>{repository.name}</strong>
          <small title={repository.path}>{repository.path}</small>
        </div>
      </div>

      <div className="sidebar__primary">
        <button
          type="button"
          className={activeView === 'changes' ? 'is-active' : ''}
          onClick={() => onViewChange('changes')}
        >
          <FileStack size={15} />
          <span>{t('localChanges')}</span>
          <b>{changeCount}</b>
        </button>
        <button
          type="button"
          className={activeView === 'history' ? 'is-active' : ''}
          onClick={() => onViewChange('history')}
        >
          <History size={15} />
          <span>{t('revisionHistory')}</span>
        </button>
        <button
          type="button"
          className={activeView === 'branches' ? 'is-active' : ''}
          onClick={() => onViewChange('branches')}
        >
          <GitBranch size={15} />
          <span>{t('branchOverview')}</span>
        </button>
        <button type="button" className={activeView === 'tags' ? 'is-active' : ''} onClick={() => onViewChange('tags')}>
          <Tags size={15} />
          <span>{t('tagList')}</span>
        </button>
      </div>

      <div className="sidebar__filter composite-input">
        <Search size={13} aria-hidden="true" />
        <input
          value={branchFilter}
          onChange={(event) => setBranchFilter(event.target.value)}
          placeholder={t('filterBranches')}
          aria-label={t('filterBranches')}
        />
      </div>

      <div className="sidebar__scroll">
        <SidebarSection title={t('branches')}>
          <button
            type="button"
            className="tree-group-label"
            aria-expanded={localExpanded}
            onClick={() => setLocalExpanded((value) => !value)}
          >
            {localExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span>{t('local')}</span>
          </button>
          {localExpanded &&
            localBranches.map((branch) => (
              <button
                key={branch.id}
                type="button"
                className={`tree-row tree-row--local ${branch.current ? 'is-current' : ''} ${branch.id === selectedBranchId ? 'is-selected' : ''}`}
                aria-current={branch.current ? 'true' : undefined}
                aria-pressed={branch.id === selectedBranchId}
                onClick={() => onBranchSelect(branch)}
                onDoubleClick={() => onBranchCheckout(branch)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  onBranchContextMenu(branch, {
                    x: event.clientX,
                    y: event.clientY,
                    anchor: event.currentTarget
                  })
                }}
                title={t('status.selectDoubleClickCheckout', { name: branch.name })}
              >
                <GitBranch size={13} />
                <span>{branch.name}</span>
                {branch.current && <CircleDot size={11} />}
                {branch.ahead && <small>↑{branch.ahead}</small>}
              </button>
            ))}

          <button
            type="button"
            className="tree-group-label"
            aria-expanded={remoteExpanded}
            onClick={() => setRemoteExpanded((value) => !value)}
          >
            {remoteExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span>{t('remote')}</span>
          </button>
          {remoteExpanded &&
            remoteBranches.map((branch) => (
              <button
                key={branch.id}
                type="button"
                className={`tree-row tree-row--remote ${branch.id === selectedBranchId ? 'is-selected' : ''}`}
                aria-pressed={branch.id === selectedBranchId}
                onClick={() => onBranchSelect(branch)}
                onDoubleClick={() => onBranchCheckout(branch)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  onBranchContextMenu(branch, {
                    x: event.clientX,
                    y: event.clientY,
                    anchor: event.currentTarget
                  })
                }}
                title={t('status.selectDoubleClickCheckout', { name: branch.name })}
              >
                <GitBranch size={13} />
                <span>{branch.name}</span>
              </button>
            ))}
        </SidebarSection>

        <SidebarSection title={t('tags')}>
          {tags.map((tag) => (
            <button
              key={tag.id}
              type="button"
              className={`tree-row tree-row--tag ${tag.id === selectedTagId ? 'is-selected' : ''}`}
              aria-pressed={tag.id === selectedTagId}
              onClick={() => onTagSelect(tag)}
              onDoubleClick={() => onTagLocateRevision(tag)}
              onContextMenu={(event) => {
                event.preventDefault()
                onTagContextMenu(tag, {
                  x: event.clientX,
                  y: event.clientY,
                  anchor: event.currentTarget
                })
              }}
              title={t('status.selectLocateRevisionNamed', { name: tag.name })}
            >
              <Tags size={13} />
              <span>{tag.name}</span>
            </button>
          ))}
          {tags.length === 0 && <div className="sidebar__empty-tree-row">{t('theCurrentRepositoryHasNoTags')}</div>}
        </SidebarSection>

        <SidebarSection title="LORE">
          <button type="button" className="tree-row tree-row--root" onClick={onOpenServer}>
            <SlidersHorizontal size={13} />
            <span>{t('cloneSelectiveSync')}</span>
          </button>
          <button type="button" className="tree-row tree-row--root" onClick={onOpenConfiguration}>
            <Settings2 size={13} />
            <span>{t('repositoryConfiguration')}</span>
          </button>
          <button type="button" className="tree-row tree-row--root" onClick={onOpenAccounts}>
            <UserRound size={13} />
            <span>{t('accounts')}</span>
          </button>
          {/* 高频入口保持直达，其余仓库能力继续收敛到完整的竖向工具导航。 */}
          <button type="button" className="tree-row tree-row--root" onClick={onOpenRepositoryTools}>
            <Database size={13} />
            <span>{t('repositoryTools')}</span>
          </button>
        </SidebarSection>

        <button
          type="button"
          className="sidebar__collapsed-row"
          aria-expanded={archivedExpanded}
          onClick={() => setArchivedExpanded((value) => !value)}
        >
          {archivedExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span>{t('archivedBranches')}</span>
        </button>
        {archivedExpanded &&
          (archivedBranches.length > 0 ? (
            archivedBranches.map((branch) => (
              <button
                key={branch.id}
                type="button"
                className={`tree-row tree-row--archived ${branch.id === selectedBranchId ? 'is-selected' : ''}`}
                aria-pressed={branch.id === selectedBranchId}
                onClick={() => onBranchSelect(branch)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  onBranchContextMenu(branch, {
                    x: event.clientX,
                    y: event.clientY,
                    anchor: event.currentTarget
                  })
                }}
                title={t('status.selectArchivedBranchNamed', { name: branch.name })}
              >
                <GitBranch size={13} />
                <span>{branch.name}</span>
              </button>
            ))
          ) : (
            <div className="sidebar__empty-tree-row">{t('noArchivedBranches')}</div>
          ))}
      </div>

      <footer className="sidebar__instance">
        <div title={t('status.instanceTooltip', { value: instanceLabel })}>
          <span>{t('instance')}</span>
          <strong>{instanceLabel}</strong>
        </div>
        <div title={t('status.partitionTooltip', { value: partitionLabel })}>
          <span>{t('partition')}</span>
          <strong>{partitionLabel}</strong>
        </div>
      </footer>
    </aside>
  )
}
