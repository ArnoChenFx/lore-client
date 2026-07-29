import {
  Binary,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  CircleDot,
  Clock3,
  Copy,
  FileCode2,
  FileJson2,
  FileSliders,
  Files,
  Folder,
  GitCommitHorizontal,
  GitMerge,
  HardDrive,
  Layers3,
  PanelRightClose,
  PanelRightOpen,
  UserRound
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { useTranslation } from 'react-i18next'

import { useClientPreferences } from '../../../hooks/useClientPreferences'
import { t } from '../../../i18n'
import { shouldDisplayRevisionAuthorEmail } from '../../../shared/lib'
import { IconButton, RevisionAuthorAvatar } from '../../../shared/ui'
import type {
  BinaryFilePreview,
  ChangeFile,
  ExternalDiffToolPreference,
  InspectorTab,
  RepositoryFileReference,
  Revision,
  RevisionFile,
  ToastMessage,
  WorkingTreeDiff
} from '../../../types'
import { RevisionChangesWorkspace, type RevisionWorkspaceSelectionRequest } from './RevisionChangesWorkspace'
import { RevisionFileContextMenu, type RevisionFileMenuRequest } from './RevisionFileContextMenu'
import { resolveRevisionTreeReveal, type RevisionTreeRevealResult } from './revisionTreeReveal'
import { reconcileRevisionTreeSelection, type RevisionTreeSelectionState } from './revisionTreeSelection'

interface InspectorProps {
  revision: Revision | null
  files: ChangeFile[]
  treeFiles?: RevisionFile[]
  /** 完整不可变 Revision Tree 是否已经加载；空树与尚未加载必须严格区分。 */
  treeReady?: boolean
  treeLoading?: boolean
  treeError?: string | null
  diffs: WorkingTreeDiff[]
  changeListLoading?: boolean
  changeListError?: string | null
  /** 区分“真实 0 个变化”和“尚未加载轻量变化清单”。 */
  changeListReady: boolean
  /** 当前 Revision 变更相对的父节点；仅多父 Revision 需要显式展示。 */
  revisionDiffSource?: string | null
  onRevisionDiffSourceChange?: (sourceRevision: string) => void
  diffLoading: boolean
  diffError: string | null
  diffNotice: string | null
  demoMode: boolean
  repositoryPath: string
  activeTab: InspectorTab
  onTabChange: (tab: InspectorTab) => void
  onLoadBinaryPreview?: (path: string, revision?: string, metadataOnly?: boolean) => Promise<BinaryFilePreview>
  onPrimaryChangeFile?: (file: ChangeFile | null) => void
  onNotify: (title: string, detail: string, tone?: ToastMessage['tone']) => void
  onRevealFile: (file: RepositoryFileReference) => void
  onFileHistory: (file: RepositoryFileReference) => void
  onResetFile: (files: RepositoryFileReference[], targetRevision: string, targetLabel: string) => void
  externalDiffTools?: ExternalDiffToolPreference[]
  onExternalDiff?: (file: ChangeFile, tool: ExternalDiffToolPreference) => void
  onOpenOperations: () => void
}

const statusLabels = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R'
} as const

interface FileSelectionModifiers {
  toggle: boolean
  range: boolean
}

function fileIcon(file: ChangeFile | RevisionFile) {
  if (file.binary) {
    return <Binary size={14} />
  }
  if (file.name.endsWith('.json')) {
    return <FileJson2 size={14} />
  }
  if (file.name.endsWith('.ini')) {
    return <FileSliders size={14} />
  }
  return <FileCode2 size={14} />
}

/** Revision 文件 DTO 的目录字段与文件名合成为唯一仓库相对路径。 */
function revisionFilePath(file: RevisionFile): string {
  return file.path === '.' || !file.path ? file.name : `${file.path}/${file.name}`
}

/** 所有仓库文件引用使用相同路径规则，供完整树与本次 Diff 建立精确关联。 */
function changePath(file: RepositoryFileReference): string {
  return file.path === '.' || !file.path ? file.name : `${file.path}/${file.name}`
}

/**
 * 从完整 Revision 文件树选区构造菜单目标。
 *
 * 返回值始终保留真实 `RevisionFile`，不会把未变更文件伪装为 `ChangeFile`；
 * 只有主要路径确实存在于本次 Diff 时才附带 `primaryChange`。
 */
export function resolveRevisionTreeMenuSelection(
  treeFiles: RevisionFile[],
  selectedFileIds: string[],
  primaryFile: RevisionFile,
  changeFiles: ChangeFile[]
) {
  const files = selectedFileIds.includes(primaryFile.id)
    ? treeFiles.filter((candidate) => selectedFileIds.includes(candidate.id))
    : [primaryFile]
  return {
    files,
    primaryFile,
    primaryChange: changeFiles.find((candidate) => changePath(candidate) === revisionFilePath(primaryFile))
  }
}

interface RevisionTreeDirectory {
  name: string
  path: string
  directories: RevisionTreeDirectory[]
  files: RevisionFile[]
}

/**
 * 从扁平已提交文件集合构造真实目录层级。
 *
 * 目录层级负责表达路径，因此文件行只需显示文件名，不再用第二行重复完整路径。
 */
function buildRevisionTree(files: RevisionFile[]): RevisionTreeDirectory {
  interface MutableDirectory {
    name: string
    path: string
    directories: Map<string, MutableDirectory>
    files: RevisionFile[]
  }
  const root: MutableDirectory = {
    name: '',
    path: '',
    directories: new Map(),
    files: []
  }

  for (const file of files) {
    const segments = file.path === '.' || !file.path ? [] : file.path.split('/').filter(Boolean)
    let directory = root
    for (const segment of segments) {
      const path = directory.path ? `${directory.path}/${segment}` : segment
      let child = directory.directories.get(segment)
      if (!child) {
        child = {
          name: segment,
          path,
          directories: new Map(),
          files: []
        }
        directory.directories.set(segment, child)
      }
      directory = child
    }
    directory.files.push(file)
  }

  const freeze = (directory: MutableDirectory): RevisionTreeDirectory => ({
    name: directory.name,
    path: directory.path,
    directories: [...directory.directories.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(freeze),
    files: [...directory.files].sort((left, right) => left.name.localeCompare(right.name))
  })
  return freeze(root)
}

/** 收集完整 Revision Tree 的目录路径，供“收起全部”一次性建立折叠集合。 */
export function collectRevisionDirectoryPaths(root: RevisionTreeDirectory): string[] {
  const paths: string[] = []
  const visit = (directory: RevisionTreeDirectory) => {
    for (const child of directory.directories) {
      paths.push(child.path)
      visit(child)
    }
  }
  visit(root)
  return paths
}

export function InspectorTabs({
  activeTab,
  filesChanged,
  diffVisible,
  onTabChange,
  onToggleDiff
}: {
  activeTab: InspectorTab
  filesChanged?: number
  diffVisible: boolean
  onTabChange: (tab: InspectorTab) => void
  onToggleDiff: () => void
}) {
  const tabs: Array<{ id: InspectorTab; label: string; count?: number }> = [
    { id: 'overview', label: t('overview') },
    { id: 'changes', label: t('changes'), count: filesChanged },
    { id: 'tree', label: t('fileTree') }
  ]

  return (
    <nav className="inspector-tabs" aria-label={t('revisionDetailTabs')}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={activeTab === tab.id ? 'is-active' : ''}
          onClick={() => onTabChange(tab.id)}
        >
          {tab.label}
          {tab.count !== undefined && <small>{tab.count}</small>}
        </button>
      ))}
      <span />
      {activeTab === 'changes' && (
        <IconButton
          className="diff-visibility-toggle inspector-tabs__diff-toggle"
          icon={diffVisible ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
          label={t(diffVisible ? 'hideDiffView' : 'showDiffView')}
          aria-pressed={diffVisible}
          onClick={onToggleDiff}
        />
      )}
    </nav>
  )
}

export function OverviewTab({
  revision,
  demoMode,
  onOpenOperations
}: {
  revision: Revision
  demoMode: boolean
  onOpenOperations: () => void
}) {
  return (
    <div className="overview-tab">
      <section className="revision-summary">
        <div className="revision-summary__lead">
          <span className="summary-kicker">
            {revision.parentCount > 1 ? <GitMerge size={13} /> : <GitCommitHorizontal size={13} />}
            {t('revision')}
          </span>
          <h2>{revision.title}</h2>
          <p>{revision.description}</p>
        </div>
      </section>

      <section className="metadata-grid">
        <article>
          <UserRound size={14} />
          <span>{t('author')}</span>
          <div className="metadata-grid__identity">
            <strong title={revision.author}>{revision.author}</strong>
            {shouldDisplayRevisionAuthorEmail(revision.author, revision.authorEmail) && (
              <small title={revision.authorEmail}>{revision.authorEmail}</small>
            )}
          </div>
        </article>
        <article>
          <Clock3 size={14} />
          <span>{t('created')}</span>
          <strong>{revision.timestamp}</strong>
        </article>
        <article>
          <GitMerge size={14} />
          <span>{t('parentRevision')}</span>
          <strong>{t('status.countOnly', { count: revision.parentCount })}</strong>
        </article>
      </section>

      {demoMode && (
        <>
          <section className="provenance-card">
            <header>
              <div>
                <strong>{t('contentSource')}</strong>
              </div>
              <span>{t('immutableStorage')}</span>
            </header>
            <div className="provenance-track">
              <span style={{ width: '62%' }} />
              <span style={{ width: '24%' }} />
              <span style={{ width: '14%' }} />
            </div>
            <div className="provenance-legend">
              <span>
                <i className="is-local" />
                {t('localReuse')} <b>62%</b>
              </span>
              <span>
                <i className="is-remote" />
                {t('remoteFetch')} <b>24%</b>
              </span>
              <span>
                <i className="is-new" />
                {t('newChunks')} <b>14%</b>
              </span>
            </div>
          </section>

          <section className="activity-section">
            <header>
              <strong>{t('revisionActivity')}</strong>
              <button type="button" onClick={onOpenOperations}>
                {t('viewFullEvent')}
              </button>
            </header>
            <ol>
              <li>
                <span className="activity-dot is-success">
                  <Check size={11} />
                </span>
                <div>
                  <strong>{t('integrityVerificationCompleted')}</strong>
                  <small>{t('all1482ChunksAreAddressable')}</small>
                </div>
                <time>15:38</time>
              </li>
              <li>
                <span className="activity-dot is-sync">
                  <HardDrive size={11} />
                </span>
                <div>
                  <strong>{t('writeToSharedStorage')}</strong>
                  <small>{t('added207MbReused892Mb')}</small>
                </div>
                <time>15:37</time>
              </li>
              <li>
                <span className="activity-dot">
                  <GitCommitHorizontal size={11} />
                </span>
                <div>
                  <strong>{t('advanceBranchTip')}</strong>
                  <small>world/lighting-pass</small>
                </div>
                <time>15:37</time>
              </li>
            </ol>
          </section>
        </>
      )}
    </div>
  )
}

function FileTreeTab({
  files,
  changeFiles,
  repositoryName,
  demoMode,
  loading,
  error,
  selectedFileId,
  selectedFileIds,
  onSelectFile,
  onSelectAll,
  onOpenChange,
  onOpenContextMenu,
  onRevealFile
}: {
  files: RevisionFile[]
  changeFiles: ChangeFile[]
  repositoryName: string
  demoMode: boolean
  loading: boolean
  error: string | null
  selectedFileId: string
  selectedFileIds: string[]
  onSelectFile: (fileId: string, modifiers: FileSelectionModifiers) => void
  onSelectAll: () => void
  onOpenChange: (file: ChangeFile) => void
  onOpenContextMenu: (file: RevisionFile, event: ReactMouseEvent<HTMLElement>) => void
  onRevealFile: (file: RevisionFile) => void
}) {
  const selectedRowRef = useRef<HTMLDivElement>(null)
  const selectedIds = new Set(selectedFileIds)
  const [rootExpanded, setRootExpanded] = useState(true)
  const [collapsedDirectories, setCollapsedDirectories] = useState<Set<string>>(() => new Set())
  const [unchangedExpanded, setUnchangedExpanded] = useState(false)
  const tree = useMemo(() => buildRevisionTree(files), [files])
  const directoryPaths = useMemo(() => collectRevisionDirectoryPaths(tree), [tree])
  const changesByPath = useMemo(
    () => new Map(changeFiles.map((file) => [changePath(file), file] as const)),
    [changeFiles]
  )

  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({
      block: 'nearest',
      behavior: 'smooth'
    })
  }, [selectedFileId])

  /**
   * 目录折叠只影响渲染，不修改 Inspector 持有的多选数组。
   * 再次展开后，主要文件与批量选区因此仍可继续用于右键操作。
   */
  const toggleDirectory = (path: string) => {
    setCollapsedDirectories((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const renderFile = (file: RevisionFile, depth: number) => {
    const change = changesByPath.get(revisionFilePath(file))
    const depthStyle = {
      '--tree-depth': depth
    } as CSSProperties
    return (
      <div
        key={file.id}
        ref={file.id === selectedFileId ? selectedRowRef : undefined}
        className={[
          'file-tree__row is-file',
          selectedIds.has(file.id) ? 'is-selected' : '',
          file.id === selectedFileId ? 'is-primary-selected' : ''
        ]
          .filter(Boolean)
          .join(' ')}
        style={depthStyle}
        role="treeitem"
        aria-level={depth + 2}
        tabIndex={0}
        aria-selected={selectedIds.has(file.id)}
        onClick={(event) =>
          onSelectFile(file.id, {
            toggle: event.ctrlKey || event.metaKey,
            range: event.shiftKey
          })
        }
        onDoubleClick={() => (change ? onOpenChange(change) : onRevealFile(file))}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            if (change) onOpenChange(change)
            else onRevealFile(file)
          }
        }}
        onContextMenu={(event) => onOpenContextMenu(file, event)}
      >
        <span />
        {fileIcon(file)}
        <strong>{file.name}</strong>
        {change ? (
          <em className={`file-status is-${change.status}`}>{statusLabels[change.status]}</em>
        ) : (
          <span className="file-tree__status-placeholder" aria-hidden="true" />
        )}
        <small>{file.size}</small>
      </div>
    )
  }

  const renderDirectory = (directory: RevisionTreeDirectory, depth: number) => {
    const expanded = !collapsedDirectories.has(directory.path)
    const depthStyle = {
      '--tree-depth': depth
    } as CSSProperties
    return (
      <div key={directory.path} className="file-tree__group" role="group">
        <button
          type="button"
          className="file-tree__row is-folder"
          style={depthStyle}
          role="treeitem"
          aria-expanded={expanded}
          aria-level={depth + 2}
          onClick={() => toggleDirectory(directory.path)}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <Folder size={14} />
          <strong>{directory.name}</strong>
        </button>
        {expanded && (
          <div className="file-tree__group" role="group">
            {directory.directories.map((child) => renderDirectory(child, depth + 1))}
            {directory.files.map((file) => renderFile(file, depth + 1))}
          </div>
        )}
      </div>
    )
  }

  const primaryFile = files.find((file) => file.id === selectedFileId) ?? files[0]

  return (
    <div className="file-tree-tab">
      <header className="file-tree-tab__summary">
        <div className="file-tree-tab__lead">
          <Files size={17} />
          <span>
            <strong>{t('revisionFileTree')}</strong>
            <small>{t('showCompleteSetFilesAlready_ece9')}</small>
          </span>
        </div>
        <div className="file-tree-tab__actions">
          <IconButton
            icon={<ChevronsDown size={14} />}
            label={t('expandAllFolders')}
            disabled={directoryPaths.length === 0 && !demoMode}
            onClick={() => {
              // 批量展开只恢复可见性；主要文件、多选数组和定位上下文保持原样。
              setRootExpanded(true)
              setCollapsedDirectories(new Set())
              if (demoMode) setUnchangedExpanded(true)
            }}
          />
          <IconButton
            icon={<ChevronsUp size={14} />}
            label={t('collapseAllFolders')}
            disabled={directoryPaths.length === 0 && !demoMode}
            onClick={() => {
              // 仓库根保持展开，使用户仍能看到一级目录并选择下一步展开位置。
              setRootExpanded(true)
              setCollapsedDirectories(new Set(directoryPaths))
              setUnchangedExpanded(false)
            }}
          />
          <button
            type="button"
            disabled={!primaryFile}
            onClick={() => {
              if (primaryFile) onRevealFile(primaryFile)
            }}
          >
            <CircleDot size={13} />
            {t('locateInWorkspace')}
          </button>
        </div>
      </header>

      <div
        className="file-tree"
        role="tree"
        aria-label={t('committedRevisionFileTree')}
        aria-multiselectable="true"
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
            event.preventDefault()
            onSelectAll()
          }
        }}
      >
        <button
          type="button"
          className="file-tree__row is-root"
          role="treeitem"
          aria-expanded={rootExpanded}
          aria-level={1}
          onClick={() => setRootExpanded((value) => !value)}
        >
          {rootExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <Folder size={15} />
          <strong>{repositoryName}</strong>
          <span>{t('status.fileCount', { count: files.length })}</span>
        </button>
        {rootExpanded && loading && (
          <div className="file-tree__empty-row" role="status">
            {t('loadingTheCommittedFileTree')}
          </div>
        )}
        {rootExpanded && error && (
          <div className="file-tree__empty-row is-error" role="alert">
            {error}
          </div>
        )}
        {rootExpanded && !loading && !error && files.length === 0 && (
          <div className="file-tree__empty-row" role="note">
            {t('thisRevisionHasNoCommittedFiles')}
          </div>
        )}
        {rootExpanded && !loading && !error && tree.directories.map((directory) => renderDirectory(directory, 0))}
        {rootExpanded && !loading && !error && tree.files.map((file) => renderFile(file, 0))}
        {rootExpanded && demoMode && (
          <>
            <button
              type="button"
              className="file-tree__row is-collapsed"
              role="treeitem"
              aria-expanded={unchangedExpanded}
              aria-level={2}
              onClick={() => setUnchangedExpanded((value) => !value)}
            >
              {unchangedExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <Folder size={14} />
              <strong>{t('remainingUnchangedContent')}</strong>
              <span>{t('msg12842Items')}</span>
            </button>
            {unchangedExpanded && (
              <div className="file-tree__empty-row" role="note">
                {t('browserDemoDataLoadUnchanged_c4d8')}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export function Inspector({
  revision,
  files,
  treeFiles,
  treeReady = treeFiles !== undefined,
  treeLoading = false,
  treeError = null,
  diffs,
  diffLoading,
  diffError,
  changeListLoading = diffLoading,
  changeListError = diffError,
  changeListReady,
  revisionDiffSource,
  onRevisionDiffSourceChange,
  diffNotice,
  demoMode,
  repositoryPath,
  activeTab,
  onTabChange,
  onLoadBinaryPreview,
  onPrimaryChangeFile,
  onNotify,
  onRevealFile,
  onFileHistory,
  onResetFile,
  externalDiffTools = [],
  onExternalDiff = () => undefined,
  onOpenOperations
}: InspectorProps) {
  const { preferences, update: updatePreferences } = useClientPreferences()
  const [contextMenu, setContextMenu] = useState<RevisionFileMenuRequest | null>(null)
  const [selectionRequest, setSelectionRequest] = useState<RevisionWorkspaceSelectionRequest | null>(null)
  const [treeSelection, setTreeSelection] = useState<RevisionTreeSelectionState>({
    selectedIds: [],
    primaryId: '',
    anchorId: null
  })
  const treeSelectionRevisionRef = useRef<string | undefined>(undefined)
  const pendingTreeRevealRef = useRef<{
    revisionId: string | undefined
    selectedFiles: RepositoryFileReference[]
    primaryFile: RepositoryFileReference
  } | null>(null)
  const effectiveTreeFiles = useMemo(
    () =>
      treeFiles ??
      files.map(
        (file): RevisionFile => ({
          id: `revision-tree-${file.id}`,
          path: file.path,
          name: file.name,
          size: file.size ?? '—',
          binary: Boolean(file.binary)
        })
      ),
    [files, treeFiles]
  )
  useEffect(() => {
    setContextMenu(null)
    setSelectionRequest(null)
    const firstFileId = effectiveTreeFiles[0]?.id ?? ''
    const revisionChanged = treeSelectionRevisionRef.current !== revision?.id
    treeSelectionRevisionRef.current = revision?.id

    if (revisionChanged) {
      if (pendingTreeRevealRef.current?.revisionId !== revision?.id) {
        pendingTreeRevealRef.current = null
      }
      // Revision 上下文变化后必须从新文件集重新建立主选区，不能让相同路径或
      // 相同演示 ID 把上一 Revision 的操作上下文带入当前 Revision。
      setTreeSelection({
        selectedIds: treeReady && firstFileId ? [firstFileId] : [],
        primaryId: treeReady ? firstFileId : '',
        anchorId: treeReady ? firstFileId || null : null
      })
      return
    }

    /*
     * 同一 Revision 的完整树可能因惰性加载或父级偏好状态更新而产生新数组引用。
     * 这里只剔除已经不存在的文件，避免“在文件树中显示”的批量选区被 effect
     * 紧接着重置；当原选区全部失效时才安全回退到第一项。
     */
    setTreeSelection((current) => reconcileRevisionTreeSelection(treeReady, effectiveTreeFiles, current))
  }, [effectiveTreeFiles, revision?.id, treeReady])

  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  const openBatchContextMenu = useCallback(
    (selectedFiles: ChangeFile[], primaryFile: ChangeFile, event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault()
      setContextMenu({
        files: selectedFiles,
        primaryFile,
        primaryChange: primaryFile,
        source: 'changes',
        x: event.clientX,
        y: event.clientY,
        anchor: event.currentTarget
      })
    },
    []
  )

  const openFileChange = useCallback(
    (file: ChangeFile) => {
      onTabChange('changes')
      setSelectionRequest({
        nonce: Date.now(),
        repositoryPath,
        revisionId: revision?.id ?? '',
        fileIds: [file.id],
        primaryFileId: file.id
      })
    },
    [onTabChange, repositoryPath, revision?.id]
  )

  /** 把已经解析完成的定位结果写入文件树选区，或给出精确的缺失路径。 */
  const applyTreeRevealResult = useCallback(
    (result: RevisionTreeRevealResult) => {
      if (result.kind === 'pending') {
        return
      }
      if (result.kind === 'missing') {
        onNotify(t('fileRevisionTree_eab1'), result.path, 'warning')
        return
      }
      setTreeSelection({
        selectedIds: result.selectedIds,
        primaryId: result.primaryId,
        anchorId: result.primaryId
      })
    },
    [onNotify]
  )

  const showFileInTree = useCallback(
    (selectedFiles: RepositoryFileReference[], primaryFile: RepositoryFileReference) => {
      const result = resolveRevisionTreeReveal(treeReady, effectiveTreeFiles, selectedFiles, primaryFile)
      if (result.kind === 'pending') {
        pendingTreeRevealRef.current = {
          revisionId: revision?.id,
          selectedFiles,
          primaryFile
        }
        onTabChange('tree')
        return
      }
      applyTreeRevealResult(result)
      onTabChange('tree')
    },
    [applyTreeRevealResult, effectiveTreeFiles, onTabChange, revision?.id, treeReady]
  )

  useEffect(() => {
    const pending = pendingTreeRevealRef.current
    if (!pending || pending.revisionId !== revision?.id || !treeReady || treeLoading || treeError) {
      return
    }
    pendingTreeRevealRef.current = null
    applyTreeRevealResult(
      resolveRevisionTreeReveal(true, effectiveTreeFiles, pending.selectedFiles, pending.primaryFile)
    )
  }, [applyTreeRevealResult, effectiveTreeFiles, revision?.id, treeError, treeLoading, treeReady])

  /** 文件树遵循普通单选、Ctrl/Cmd 增减和 Shift 连续范围的桌面语义。 */
  const selectTreeFile = useCallback(
    (fileId: string, modifiers: FileSelectionModifiers) => {
      const orderedIds = effectiveTreeFiles.map((file) => file.id)
      let next: string[]
      if (modifiers.range && treeSelection.anchorId) {
        const anchorIndex = orderedIds.indexOf(treeSelection.anchorId)
        const targetIndex = orderedIds.indexOf(fileId)
        const range =
          anchorIndex >= 0 && targetIndex >= 0
            ? orderedIds.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1)
            : [fileId]
        next = modifiers.toggle ? [...new Set([...treeSelection.selectedIds, ...range])] : range
      } else if (modifiers.toggle) {
        next = treeSelection.selectedIds.includes(fileId)
          ? treeSelection.selectedIds.filter((id) => id !== fileId)
          : [...treeSelection.selectedIds, fileId]
      } else {
        next = [fileId]
      }
      setTreeSelection({
        selectedIds: next,
        primaryId: next.includes(fileId) ? fileId : (next.at(-1) ?? ''),
        anchorId: modifiers.range ? treeSelection.anchorId : fileId
      })
    },
    [effectiveTreeFiles, treeSelection]
  )

  const openTreeContextMenu = useCallback(
    (file: RevisionFile, event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault()
      const alreadySelected = treeSelection.selectedIds.includes(file.id)
      if (!alreadySelected) {
        setTreeSelection({
          selectedIds: [file.id],
          primaryId: file.id,
          anchorId: file.id
        })
      }

      const selection = resolveRevisionTreeMenuSelection(
        effectiveTreeFiles,
        alreadySelected ? treeSelection.selectedIds : [file.id],
        file,
        files
      )
      /*
       * 完整树文件无论是否属于本次 Diff 都进入菜单。变更专属动作通过
       * `primaryChange` 单独判断，历史、还原、定位和复制仍对每个真实文件可用。
       */
      setContextMenu({
        ...selection,
        source: 'tree',
        x: event.clientX,
        y: event.clientY,
        anchor: event.currentTarget
      })
    },
    [effectiveTreeFiles, files, treeSelection.selectedIds]
  )

  if (!revision) {
    return (
      <aside className="inspector" aria-label={t('revisionInspector')}>
        <div className="empty-state">
          <GitCommitHorizontal size={24} />
          <strong>{t('thisRepositoryHasNoRevisions')}</strong>
          <span>{t('stagingFilesCreatingFirstRevision_c33c')}</span>
        </div>
      </aside>
    )
  }

  const copyRevisionId = async () => {
    await navigator.clipboard?.writeText(revision.id)
    onNotify(t('revisionIdCopied'), revision.shortId)
  }

  return (
    <>
      <aside className="inspector" aria-label={t('revisionInspector')}>
        <header className="inspector__identity">
          <RevisionAuthorAvatar
            identity={revision.authorEmail ?? revision.author}
            initials={revision.initials}
            variant="detail"
          />
          <div>
            <span className="inspector__author-line">
              <strong title={revision.author}>{revision.author}</strong>
              {/*
               * Inspector 使用同一份历史 DTO 展示邮箱；这里只渲染显式历史值，
               * 不从当前设置推断，避免改变旧 Revision 的作者事实。
               */}
              {shouldDisplayRevisionAuthorEmail(revision.author, revision.authorEmail) && (
                <small title={revision.authorEmail}>{revision.authorEmail}</small>
              )}
            </span>
            <span className="inspector__revision-meta">
              <code>{revision.shortId}</code>
              <time>{revision.timestamp}</time>
            </span>
          </div>
          <IconButton icon={<Copy size={14} />} label={t('copyFullRevisionId')} onClick={() => void copyRevisionId()} />
        </header>

        <InspectorTabs
          activeTab={activeTab}
          filesChanged={changeListReady ? revision.filesChanged : undefined}
          diffVisible={preferences.revisionChangesDiffVisible}
          onTabChange={onTabChange}
          onToggleDiff={() =>
            updatePreferences({
              revisionChangesDiffVisible: !preferences.revisionChangesDiffVisible
            })
          }
        />

        <div className="inspector__body">
          {activeTab === 'overview' && (
            <OverviewTab revision={revision} demoMode={demoMode} onOpenOperations={onOpenOperations} />
          )}
          {activeTab === 'changes' && (
            <RevisionChangesWorkspace
              repositoryPath={repositoryPath}
              revision={revision}
              files={files}
              diffs={diffs}
              loading={changeListLoading}
              error={changeListError}
              diffSourceRevision={revisionDiffSource}
              onDiffSourceRevisionChange={onRevisionDiffSourceChange}
              diffLoading={diffLoading}
              diffError={diffError}
              notice={diffNotice}
              onLoadBinaryPreview={onLoadBinaryPreview}
              onPrimaryFileChange={onPrimaryChangeFile}
              selectionRequest={selectionRequest}
              onOpenContextMenu={openBatchContextMenu}
            />
          )}
          {activeTab === 'tree' && (
            <FileTreeTab
              files={effectiveTreeFiles}
              changeFiles={files}
              repositoryName={
                repositoryPath
                  .replace(/[\\/]+$/, '')
                  .split(/[\\/]/)
                  .at(-1) ?? t('loreRepository')
              }
              demoMode={demoMode}
              loading={treeLoading}
              error={treeError}
              selectedFileId={treeSelection.primaryId}
              selectedFileIds={treeSelection.selectedIds}
              onSelectFile={selectTreeFile}
              onSelectAll={() => {
                const ids = effectiveTreeFiles.map((file) => file.id)
                setTreeSelection({
                  selectedIds: ids,
                  primaryId: ids[0] ?? '',
                  anchorId: ids[0] ?? null
                })
              }}
              onOpenChange={openFileChange}
              onOpenContextMenu={openTreeContextMenu}
              onRevealFile={onRevealFile}
            />
          )}
        </div>
      </aside>
      {contextMenu && (
        <RevisionFileContextMenu
          request={contextMenu}
          revision={revision}
          repositoryPath={repositoryPath}
          externalDiffTools={externalDiffTools}
          onClose={closeContextMenu}
          onOpenChange={openFileChange}
          onExternalDiff={onExternalDiff}
          onShowInTree={showFileInTree}
          onRevealFile={onRevealFile}
          onHistory={onFileHistory}
          onResetFile={onResetFile}
          onNotify={onNotify}
        />
      )}
    </>
  )
}
