import {
  ChevronDown,
  ChevronRight,
  CircleDot,
  Database,
  FileStack,
  Folder,
  FolderOpen,
  GitBranch,
  History,
  Search,
  Settings2,
  SlidersHorizontal,
  Tags,
  UserRound
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  buildSidebarBranchTree,
  buildSidebarTagTree,
  sortBranchesByEnglishName,
  type SidebarBranchTreeNode,
  type SidebarPathTreeLeaf,
  type SidebarPathTreeNode,
  type SidebarTagTreeNode
} from '../../shared/lib'
import type { ContextMenuPoint } from '../../shared/ui'
import type { Branch, LoreTag, NavigationView, Repository, RepositoryIconId } from '../../types'
import { RepositoryIconPicker } from './RepositoryIconPicker'

interface SidebarProps {
  repository: Repository
  branches: Branch[]
  tags: LoreTag[]
  demoMode: boolean
  activeView: NavigationView
  selectedBranchId: string
  selectedTagId: string
  changeCount: number
  repositoryIcon: RepositoryIconId
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
  onRepositoryIconChange: (icon: RepositoryIconId | null) => void
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
    localBranches: sortBranchesByEnglishName(visibleBranches.filter((branch) => !branch.remote && !branch.archived)),
    remoteBranches: sortBranchesByEnglishName(visibleBranches.filter((branch) => branch.remote && !branch.archived)),
    archivedBranches: sortBranchesByEnglishName(visibleBranches.filter((branch) => branch.archived))
  }
}

type SidebarTreeScope = 'local' | 'remote' | 'tag'

interface SidebarPathTreeProps<T> {
  nodes: SidebarPathTreeNode<T>[]
  scope: SidebarTreeScope
  repositoryId: string
  depth?: number
  collapsedFolders: ReadonlySet<string>
  onFolderToggle: (folderKey: string) => void
  renderLeaf: (leaf: SidebarPathTreeLeaf<T>, depth: number) => React.ReactNode
}

/**
 * 递归渲染 Branch 与 Tag 共用的路径投影。
 *
 * 目录按钮只维护展开状态；所有 Lore 动作由调用方绑定到真实叶子。原生 button 负责
 * Enter/Space 键盘操作，`aria-expanded` 明确暴露树状分组状态。缩进通过一个局部
 * CSS 变量传递，不引入主题分支，也不改变叶子的完整可访问名称。
 */
function SidebarPathTree<T>({
  nodes,
  scope,
  repositoryId,
  depth = 0,
  collapsedFolders,
  onFolderToggle,
  renderLeaf
}: SidebarPathTreeProps<T>) {
  return nodes.map((node) => {
    if (node.kind === 'folder') {
      // 仓库、对象类型与路径共同进入 key，避免本地、远程和标签的同名目录相互串扰。
      const folderKey = `${repositoryId}:${scope}:${node.path}`
      const expanded = !collapsedFolders.has(folderKey)
      return (
        <div key={`folder:${node.path}`} className={`sidebar-path-folder sidebar-path-folder--${scope}`}>
          <button
            type="button"
            className="tree-row tree-row--folder"
            style={{ '--tree-indent': `${9 + depth * 14}px` } as React.CSSProperties}
            aria-label={node.path}
            aria-expanded={expanded}
            onClick={() => onFolderToggle(folderKey)}
            title={node.path}
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {expanded ? <FolderOpen size={13} /> : <Folder size={13} />}
            <span>{node.name}</span>
          </button>
          {expanded && (
            <SidebarPathTree
              nodes={node.children}
              scope={scope}
              repositoryId={repositoryId}
              depth={depth + 1}
              collapsedFolders={collapsedFolders}
              onFolderToggle={onFolderToggle}
              renderLeaf={renderLeaf}
            />
          )}
        </div>
      )
    }

    return renderLeaf(node, depth)
  })
}

interface BranchTreeProps {
  nodes: SidebarBranchTreeNode[]
  scope: 'local' | 'remote'
  repositoryId: string
  selectedBranchId: string
  collapsedFolders: ReadonlySet<string>
  onFolderToggle: (folderKey: string) => void
  onBranchSelect: (branch: Branch) => void
  onBranchCheckout: (branch: Branch) => void
  onBranchContextMenu: (branch: Branch, point: ContextMenuPoint) => void
}

function BranchTree({
  nodes,
  scope,
  repositoryId,
  selectedBranchId,
  collapsedFolders,
  onFolderToggle,
  onBranchSelect,
  onBranchCheckout,
  onBranchContextMenu
}: BranchTreeProps) {
  const { t } = useTranslation()

  return (
    <SidebarPathTree
      nodes={nodes}
      scope={scope}
      repositoryId={repositoryId}
      collapsedFolders={collapsedFolders}
      onFolderToggle={onFolderToggle}
      renderLeaf={(node, depth) => {
        const branch = node.item
        const selected = branch.id === selectedBranchId
        const rowClasses = [
          'tree-row',
          `tree-row--${scope}`,
          'tree-row--path-node',
          'tree-row--branch-node',
          branch.current ? 'is-current' : '',
          selected ? 'is-selected' : ''
        ]
          .filter(Boolean)
          .join(' ')

        return (
          <button
            key={`branch:${branch.id}`}
            type="button"
            className={rowClasses}
            style={{ '--tree-indent': `${23 + depth * 14}px` } as React.CSSProperties}
            aria-label={branch.name}
            aria-current={branch.current ? 'true' : undefined}
            aria-pressed={selected}
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
            <span>{node.name}</span>
            {branch.current && <CircleDot size={11} />}
            {branch.ahead && <small>↑{branch.ahead}</small>}
          </button>
        )
      }}
    />
  )
}

interface TagTreeProps {
  nodes: SidebarTagTreeNode[]
  repositoryId: string
  selectedTagId: string
  collapsedFolders: ReadonlySet<string>
  onFolderToggle: (folderKey: string) => void
  onTagSelect: (tag: LoreTag) => void
  onTagLocateRevision: (tag: LoreTag) => void
  onTagContextMenu: (tag: LoreTag, point: ContextMenuPoint) => void
}

/** 标签树只共享目录投影；选择、定位与管理动作始终绑定真实 LoreTag 叶子。 */
function TagTree({
  nodes,
  repositoryId,
  selectedTagId,
  collapsedFolders,
  onFolderToggle,
  onTagSelect,
  onTagLocateRevision,
  onTagContextMenu
}: TagTreeProps) {
  const { t } = useTranslation()

  return (
    <SidebarPathTree
      nodes={nodes}
      scope="tag"
      repositoryId={repositoryId}
      collapsedFolders={collapsedFolders}
      onFolderToggle={onFolderToggle}
      renderLeaf={(node, depth) => {
        const tag = node.item
        const selected = tag.id === selectedTagId
        return (
          <button
            key={`tag:${tag.id}`}
            type="button"
            className={`tree-row tree-row--tag tree-row--path-node ${selected ? 'is-selected' : ''}`}
            style={{ '--tree-indent': `${23 + depth * 14}px` } as React.CSSProperties}
            aria-label={tag.name}
            aria-pressed={selected}
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
            <span>{node.name}</span>
          </button>
        )
      }}
    />
  )
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
  repositoryIcon,
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
  onOpenRepositoryTools,
  onRepositoryIconChange
}: SidebarProps) {
  const { t } = useTranslation()
  // 分支筛选只影响侧栏投影，不参与仓库查询或其他工作区，因此由侧栏自行持有。
  const [branchFilter, setBranchFilter] = useState('')
  const { localBranches, remoteBranches, archivedBranches } = useMemo(
    () => groupSidebarBranches(branches, branchFilter),
    [branches, branchFilter]
  )
  const localBranchTree = useMemo(() => buildSidebarBranchTree(localBranches), [localBranches])
  const remoteBranchTree = useMemo(() => buildSidebarBranchTree(remoteBranches), [remoteBranches])
  const tagTree = useMemo(() => buildSidebarTagTree(tags), [tags])
  const instanceLabel = demoMode ? '019c•••f18a' : t('localClient')
  const partitionLabel = demoMode ? 'meridian-prod' : t('default')
  // 二级分组独立控制，折叠只隐藏行，不改变筛选结果和当前 Branch 选区。
  const [localExpanded, setLocalExpanded] = useState(true)
  const [remoteExpanded, setRemoteExpanded] = useState(true)
  const [archivedExpanded, setArchivedExpanded] = useState(false)
  // 仅记录例外的“已折叠”目录，让新出现的路径默认展开，并且不需要同步维护目录全集。
  const [collapsedPathFolders, setCollapsedPathFolders] = useState<Set<string>>(() => new Set())
  const togglePathFolder = (folderKey: string) => {
    setCollapsedPathFolders((current) => {
      const next = new Set(current)
      if (next.has(folderKey)) next.delete(folderKey)
      else next.add(folderKey)
      return next
    })
  }

  return (
    <aside className="sidebar">
      <div className="sidebar__repo-heading">
        <RepositoryIconPicker
          repositoryName={repository.name}
          icon={repositoryIcon}
          onChange={onRepositoryIconChange}
        />
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
          {localExpanded && (
            <BranchTree
              nodes={localBranchTree}
              scope="local"
              repositoryId={repository.id}
              selectedBranchId={selectedBranchId}
              collapsedFolders={collapsedPathFolders}
              onFolderToggle={togglePathFolder}
              onBranchSelect={onBranchSelect}
              onBranchCheckout={onBranchCheckout}
              onBranchContextMenu={onBranchContextMenu}
            />
          )}

          <button
            type="button"
            className="tree-group-label"
            aria-expanded={remoteExpanded}
            onClick={() => setRemoteExpanded((value) => !value)}
          >
            {remoteExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span>{t('remote')}</span>
          </button>
          {remoteExpanded && (
            <BranchTree
              nodes={remoteBranchTree}
              scope="remote"
              repositoryId={repository.id}
              selectedBranchId={selectedBranchId}
              collapsedFolders={collapsedPathFolders}
              onFolderToggle={togglePathFolder}
              onBranchSelect={onBranchSelect}
              onBranchCheckout={onBranchCheckout}
              onBranchContextMenu={onBranchContextMenu}
            />
          )}
        </SidebarSection>

        <SidebarSection title={t('tags')}>
          <TagTree
            nodes={tagTree}
            repositoryId={repository.id}
            selectedTagId={selectedTagId}
            collapsedFolders={collapsedPathFolders}
            onFolderToggle={togglePathFolder}
            onTagSelect={onTagSelect}
            onTagLocateRevision={onTagLocateRevision}
            onTagContextMenu={onTagContextMenu}
          />
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
