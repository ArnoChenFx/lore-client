import {
  Binary,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  File,
  FileQuestion,
  Folder,
  FolderOpen,
  List,
  ListTree,
  Search,
  TriangleAlert
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { useClientPreferences } from '../../../hooks/useClientPreferences'
import { resolveTheme } from '../../../hooks/useTheme'
import { t } from '../../../i18n'
import {
  buildChangeTreeRows,
  changeDirectoryPathFromObjectId,
  changeFileObjectId,
  changeFilePath,
  changeFilePathTransition,
  countUnifiedDiffLines,
  ignoreSupersededTaskError,
  isChangeDirectoryObjectId,
  LatestTaskQueue,
  parseUnifiedDiff,
  repositoryFileContentKind,
  resolvedDiffContentKind,
  resolveSelectedChangeFiles,
  selectChangeContext,
  selectChangeFile,
  shouldUseRepositoryPreview,
  settleTasksSequentially,
  type ChangeViewMode
} from '../../../shared/lib'
import {
  BinaryDiffPreview,
  createBinaryDiffPreviewView,
  DiffOptionsControl,
  PaneResizer,
  SelectInput,
  TextDiffView,
  type BinaryDiffPreviewView
} from '../../../shared/ui'
import type {
  BinaryDiffPreview as BinaryDiffPreviewData,
  BinaryFilePreview,
  ChangeFile,
  Revision,
  WorkingTreeDiff
} from '../../../types'

interface RevisionChangesWorkspaceProps {
  repositoryPath: string
  revision: Revision
  files: ChangeFile[]
  diffs: WorkingTreeDiff[]
  loading: boolean
  error: string | null
  /** 多父 Revision 当前采用的比较基线。 */
  diffSourceRevision?: string | null
  onDiffSourceRevisionChange?: (sourceRevision: string) => void
  /** 右侧主要选择文件的按需 Diff 状态；未提供时兼容旧调用方并沿用清单状态。 */
  diffLoading?: boolean
  diffError?: string | null
  notice?: string | null
  selectionRequest?: RevisionWorkspaceSelectionRequest | null
  onLoadBinaryPreview?: (path: string, revision?: string, metadataOnly?: boolean) => Promise<BinaryFilePreview>
  onPrimaryFileChange?: (file: ChangeFile | null) => void
  onOpenContextMenu: (files: ChangeFile[], primaryFile: ChangeFile, event: MouseEvent<HTMLElement>) => void
}

const DEFAULT_BROWSER_WIDTH = 220

/**
 * Revision 的轻量变更清单就绪后默认选择第一项。
 *
 * 选择本身不绕过内容视图开关：父控制器只有在 Diff 面板可见时才读取文本补丁，
 * 二进制预览也同时受 Diff 与二进制显示偏好约束。仓库和 Revision 上下文仍会参与
 * 请求校验，确保自动选择不会让上一仓库的结果写回当前视图。
 */
export function createDefaultRevisionChangeSelection(
  files: ChangeFile[],
  viewMode: ChangeViewMode = 'flat'
): {
  selectedObjectIds: string[]
  primaryObjectId: string
} {
  /*
   * Tree 会先按目录层级和名称排序，不能继续把后端平铺数组的首项当成视觉首文件。
   * 目录本身不能显示文件 Diff，因此跳过目录行并选择第一条真实文件行。
   */
  const firstFile =
    viewMode === 'tree'
      ? buildChangeTreeRows(files, new Set(), 'revision').find((row) => row.kind === 'file')?.file
      : files[0]
  const firstObjectId = firstFile ? changeFileObjectId(firstFile.id) : ''
  return {
    selectedObjectIds: firstObjectId ? [firstObjectId] : [],
    primaryObjectId: firstObjectId
  }
}

export interface RevisionWorkspaceSelectionRequest {
  nonce: number
  repositoryPath: string
  revisionId: string
  fileIds: string[]
  primaryFileId: string
  mode?: ChangeViewMode
}

/** 防止父组件 effect 尚未清空的旧定位请求在新 Repository 的子 effect 中抢先执行。 */
export function isRevisionWorkspaceSelectionRequestCurrent(
  request: RevisionWorkspaceSelectionRequest,
  repositoryPath: string,
  revisionId: string
): boolean {
  return request.repositoryPath === repositoryPath && request.revisionId === revisionId
}

const statusLabels = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R'
} as const

/**
 * Revision 的变更浏览器与本地更改共用对象选择模型，但拥有独立视图偏好。
 *
 * 目录只在右键批量操作时解析为后代文件；视觉选中态始终属于对象本身，
 * 因而选择目录不会连带高亮子项，选择文件也不会反推父目录。
 */
export function RevisionChangesWorkspace({
  repositoryPath,
  revision,
  files,
  diffs,
  loading,
  error,
  diffSourceRevision,
  onDiffSourceRevisionChange,
  diffLoading = loading,
  diffError = error,
  notice,
  selectionRequest,
  onLoadBinaryPreview,
  onPrimaryFileChange,
  onOpenContextMenu
}: RevisionChangesWorkspaceProps) {
  const { t } = useTranslation()
  const { preferences, ready: preferencesReady, update: updatePreferences } = useClientPreferences()
  const [viewMode, setViewMode] = useState<ChangeViewMode>(preferences.revisionChangesView)
  const [query, setQuery] = useState('')
  const [collapsedDirectories, setCollapsedDirectories] = useState<Set<string>>(() => new Set())
  /*
   * 轻量变更清单到达后默认建立第一项主选择。完整内容是否读取仍由 Diff 可见性
   * 控制；自动选择只恢复桌面客户端的即时浏览体验，不允许旧上下文结果写回。
   */
  const initialSelection = createDefaultRevisionChangeSelection(files, viewMode)
  const [selectedObjectIds, setSelectedObjectIds] = useState<string[]>(initialSelection.selectedObjectIds)
  const [primaryObjectId, setPrimaryObjectId] = useState(initialSelection.primaryObjectId)
  const [contentSelectionAuthorized, setContentSelectionAuthorized] = useState(
    Boolean(initialSelection.primaryObjectId)
  )
  const [browserWidth, setBrowserWidth] = useState(preferences.revisionChangesBrowserWidth)
  const [binaryPreview, setBinaryPreview] = useState<BinaryDiffPreviewView | null>(null)
  const [binaryPreviewLoading, setBinaryPreviewLoading] = useState(false)
  const [binaryPreviewError, setBinaryPreviewError] = useState<string | null>(null)
  const [workspaceElement, setWorkspaceElement] = useState<HTMLDivElement | null>(null)
  const selectionAnchorRef = useRef<string | null>(null)
  /*
   * Revision 清单到达时读取最新视图模式；模式切换本身不进入默认选择 effect，
   * 因而不会破坏“平铺/树视图切换保留现有文件选区”的桌面语义。
   */
  const viewModeRef = useRef(viewMode)
  viewModeRef.current = viewMode
  const previewRequestCounter = useRef(0)
  const previewQueue = useRef(new LatestTaskQueue())
  const diffVisible = preferences.revisionChangesDiffVisible
  const showDiffSourceSelector = revision.parentIds.length > 1 && Boolean(onDiffSourceRevisionChange)

  const visibleFiles = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return files
    return files.filter((file) => {
      const transition = changeFilePathTransition(file)
      return [changeFilePath(file), transition?.sourcePath]
        .filter(Boolean)
        .some((path) => path!.toLocaleLowerCase().includes(normalized))
    })
  }, [files, query])
  const visibleRows = useMemo(
    () => buildChangeTreeRows(visibleFiles, collapsedDirectories, 'revision'),
    [collapsedDirectories, visibleFiles]
  )
  const allRows = useMemo(() => buildChangeTreeRows(files, new Set(), 'revision'), [files])
  const allDirectoryPaths = useMemo(
    () => allRows.filter((row) => row.kind === 'directory').map((row) => row.path),
    [allRows]
  )
  const orderedObjectIds =
    viewMode === 'tree' ? visibleRows.map((row) => row.id) : visibleFiles.map((file) => changeFileObjectId(file.id))
  const selectedSet = new Set(selectedObjectIds)
  const resolvedSelectedFiles = resolveSelectedChangeFiles(selectedObjectIds, files, allRows)
  const primaryFile = files.find((file) => changeFileObjectId(file.id) === primaryObjectId) ?? null
  const primaryPathTransition = primaryFile ? changeFilePathTransition(primaryFile) : null
  const primaryDirectory = changeDirectoryPathFromObjectId(primaryObjectId)
  const primaryDiff = primaryFile
    ? (diffs.find((diff) => diff.path.replaceAll('\\', '/') === changeFilePath(primaryFile)) ?? null)
    : null
  const diffLines = useMemo(() => (primaryDiff?.patch ? parseUnifiedDiff(primaryDiff.patch) : []), [primaryDiff?.patch])
  const diffLineCounts = useMemo(() => countUnifiedDiffLines(diffLines), [diffLines])
  const primaryContentKind = resolvedDiffContentKind(primaryFile, primaryDiff)
  const themeType = resolveTheme(preferences.theme)
  const previewModeActive = primaryFile
    ? shouldUseRepositoryPreview(
        primaryFile,
        changeFilePath(primaryFile),
        preferences.binaryDiffVisible,
        primaryContentKind
      )
    : false

  useEffect(() => {
    const queue = previewQueue.current
    queue.activate()
    return () => {
      previewRequestCounter.current += 1
      queue.dispose()
    }
  }, [])

  useEffect(() => {
    if (!preferencesReady) return
    setViewMode(preferences.revisionChangesView)
    setBrowserWidth(preferences.revisionChangesBrowserWidth)
  }, [preferences.revisionChangesBrowserWidth, preferences.revisionChangesView, preferencesReady])

  useEffect(() => {
    const nextSelection = createDefaultRevisionChangeSelection(files, viewModeRef.current)
    setSelectedObjectIds(nextSelection.selectedObjectIds)
    setPrimaryObjectId(nextSelection.primaryObjectId)
    setContentSelectionAuthorized(Boolean(nextSelection.primaryObjectId))
    selectionAnchorRef.current = nextSelection.primaryObjectId || null
    setCollapsedDirectories(new Set())
  }, [files, revision.id])

  /** 把稳定主要选择上报给 App，使后端只读取这一条路径的真实 unified diff。 */
  useEffect(() => {
    onPrimaryFileChange?.(contentSelectionAuthorized ? primaryFile : null)
  }, [contentSelectionAuthorized, onPrimaryFileChange, primaryFile])

  /**
   * 只为主选择读取可预览的前后版本。
   *
   * 目录与多选中的非主文件不会触发 Store 读取；真二进制与专用资产在关闭预览时只读
   * Tree 大小元数据，文本 CSV/SVG 则切换到文本 Diff。快速切换对象时通过序号丢弃旧请求。
   */
  useEffect(() => {
    const queue = previewQueue.current
    previewRequestCounter.current += 1
    const requestId = previewRequestCounter.current
    queue.cancelPending()
    setBinaryPreview(null)
    setBinaryPreviewError(null)

    if (!contentSelectionAuthorized || !diffVisible || !primaryFile || !previewModeActive) {
      setBinaryPreviewLoading(false)
      return
    }
    if (!onLoadBinaryPreview) {
      setBinaryPreviewLoading(false)
      setBinaryPreviewError(t('runtimeProvideRealFileContent_aae6'))
      return
    }

    const path = changeFilePath(primaryFile)
    const requests: Array<{
      side: keyof BinaryDiffPreviewData
      load: () => Promise<BinaryFilePreview>
    }> = []
    const sourceRevision = diffSourceRevision ?? revision.parentIds[0]
    if (primaryFile.status !== 'added' && sourceRevision) {
      requests.push({
        side: 'before',
        load: () => onLoadBinaryPreview(path, sourceRevision, !preferences.binaryDiffVisible)
      })
    }
    if (primaryFile.status !== 'deleted') {
      requests.push({
        side: 'after',
        load: () => onLoadBinaryPreview(path, revision.id, !preferences.binaryDiffVisible)
      })
    }
    if (requests.length === 0) {
      setBinaryPreviewLoading(false)
      setBinaryPreviewError(t('changeReadablePreviewVersion_8fe5'))
      return
    }

    setBinaryPreviewLoading(true)
    void queue
      .run(() => settleTasksSequentially(requests.map((request) => request.load)))
      .then((results) => {
        if (requestId !== previewRequestCounter.current) return
        const next: BinaryDiffPreviewData = {}
        const errors: string[] = []
        results.forEach((result, index) => {
          const request = requests[index]
          if (!request) return
          if (result.status === 'fulfilled') {
            next[request.side] = result.value
          } else {
            errors.push(readPreviewError(result.reason))
          }
        })
        if (next.before || next.after) {
          setBinaryPreview(createBinaryDiffPreviewView(next))
        } else {
          setBinaryPreviewError(errors.join('；') || t('loreReturnPreviewableFileContent_451e'))
        }
      })
      // 快速切换主动淘汰尚未开始的预览，这是预期控制流；真实异常仍由处理器重新抛出。
      .catch(ignoreSupersededTaskError)
      .finally(() => {
        if (requestId === previewRequestCounter.current) {
          setBinaryPreviewLoading(false)
        }
      })
    // 组件卸载或依赖变化时主动清空预览数据，加速垃圾回收。
    return () => {
      queue.cancelPending()
      setBinaryPreview(null)
      setBinaryPreviewError(null)
    }
  }, [
    contentSelectionAuthorized,
    diffVisible,
    onLoadBinaryPreview,
    preferences.binaryDiffVisible,
    previewModeActive,
    primaryContentKind,
    primaryFile,
    revision.id,
    revision.parentIds,
    diffSourceRevision,
    t
  ])

  useEffect(() => {
    if (!selectionRequest) return
    if (!isRevisionWorkspaceSelectionRequestCurrent(selectionRequest, repositoryPath, revision.id)) {
      return
    }
    const requestedIds = selectionRequest.fileIds
      .filter((fileId) => files.some((file) => file.id === fileId))
      .map(changeFileObjectId)
    const primaryId = files.some((file) => file.id === selectionRequest.primaryFileId)
      ? changeFileObjectId(selectionRequest.primaryFileId)
      : (requestedIds[0] ?? '')

    setSelectedObjectIds(requestedIds)
    setPrimaryObjectId(primaryId)
    setContentSelectionAuthorized(Boolean(primaryId))
    selectionAnchorRef.current = primaryId || null
    if (selectionRequest.mode) {
      setViewMode(selectionRequest.mode)
      updatePreferences({ revisionChangesView: selectionRequest.mode })
    }
  }, [files, repositoryPath, revision.id, selectionRequest, updatePreferences])

  /**
   * Revision 文件列表宽度以像素保存，拖动时同时保证文件树和 Diff
   * 各自保留最低可用宽度；窄窗口中会自动把上一次保存值夹紧。
   */
  const resizeBrowser = useCallback(
    (nextWidth: number, containerWidth: number) => {
      const minimumBrowserWidth = 150
      const minimumDiffWidth = 180
      const maximumBrowserWidth = Math.max(minimumBrowserWidth, containerWidth - minimumDiffWidth - 5)
      const safeWidth = Math.round(Math.min(maximumBrowserWidth, Math.max(minimumBrowserWidth, nextWidth)))
      setBrowserWidth(safeWidth)
      updatePreferences({ revisionChangesBrowserWidth: safeWidth })
    },
    [updatePreferences]
  )

  useEffect(() => {
    if (!diffVisible || !workspaceElement) return
    const keepWidthInsideWorkspace = () => resizeBrowser(browserWidth, workspaceElement.clientWidth)
    keepWidthInsideWorkspace()

    // 外层 Inspector 也能被用户拖动，ResizeObserver 负责同步夹紧内部列宽。
    const observer = new ResizeObserver(keepWidthInsideWorkspace)
    observer.observe(workspaceElement)
    return () => observer.disconnect()
  }, [browserWidth, diffVisible, resizeBrowser, workspaceElement])

  const setMode = (mode: ChangeViewMode) => {
    if (mode === 'flat' && selectedObjectIds.some(isChangeDirectoryObjectId)) {
      // 平铺视图不渲染目录；转换为文件对象后，选区和右键操作范围仍然可见。
      const fileObjectIds = resolvedSelectedFiles.map((file) => changeFileObjectId(file.id))
      setSelectedObjectIds(fileObjectIds)
      setPrimaryObjectId(fileObjectIds[0] ?? '')
      selectionAnchorRef.current = fileObjectIds[0] ?? null
    }
    setViewMode(mode)
    updatePreferences({ revisionChangesView: mode })
  }

  const selectObject = (objectId: string, event: Pick<MouseEvent<HTMLElement>, 'ctrlKey' | 'metaKey' | 'shiftKey'>) => {
    const next = selectChangeFile(orderedObjectIds, selectedObjectIds, objectId, selectionAnchorRef.current, {
      toggle: event.ctrlKey || event.metaKey,
      range: event.shiftKey
    })
    setSelectedObjectIds(next.selectedIds)
    selectionAnchorRef.current = next.anchorId
    setPrimaryObjectId(next.selectedIds.includes(objectId) ? objectId : (next.selectedIds.at(-1) ?? ''))
    setContentSelectionAuthorized(true)
  }

  const openContextMenu = (
    objectId: string,
    targetFiles: ChangeFile[],
    targetPrimary: ChangeFile,
    event: MouseEvent<HTMLElement>
  ) => {
    event.preventDefault()
    const targetAlreadySelected = selectedSet.has(objectId)
    const nextSelection = selectChangeContext(selectedObjectIds, objectId)
    // 右击已处于多选集合中的对象时保留整组选择，但必须把右击对象提升为主选。
    // 上下文菜单后续动作以 targetPrimary 为目标；若这里仍保留旧主选，
    // “在文件树中显示”等动作的实际目标会与源列表的视觉主选不一致。
    setSelectedObjectIds(nextSelection.selectedIds)
    setPrimaryObjectId(nextSelection.primaryId)
    setContentSelectionAuthorized(true)
    selectionAnchorRef.current = nextSelection.anchorId
    onOpenContextMenu(
      targetAlreadySelected && resolvedSelectedFiles.length > 0 ? resolvedSelectedFiles : targetFiles,
      targetPrimary,
      event
    )
  }

  const renderFile = (file: ChangeFile, depth = 0) => {
    const objectId = changeFileObjectId(file.id)
    const selected = selectedSet.has(objectId)
    const pathTransition = changeFilePathTransition(file)
    const transitionText = pathTransition
      ? t('status.pathTransition', {
          source: pathTransition.sourcePath,
          target: pathTransition.targetPath
        })
      : null
    const transitionDescription = pathTransition
      ? t(pathTransition.kind === 'moved' ? 'status.movedFromTo' : 'status.renamedFromTo', {
          source: pathTransition.sourcePath,
          target: pathTransition.targetPath
        })
      : null
    return (
      <div
        key={objectId}
        role="option"
        aria-selected={selected}
        tabIndex={selected ? 0 : -1}
        data-change-path={changeFilePath(file)}
        className={`revision-change-row is-file ${selected ? 'is-selected' : ''} ${primaryObjectId === objectId ? 'is-primary' : ''}`}
        style={{ '--tree-depth': depth } as CSSProperties}
        onClick={(event) => selectObject(objectId, event)}
        onContextMenu={(event) => openContextMenu(objectId, [file], file, event)}
      >
        <span className={`file-status is-${file.status}`} title={transitionDescription ?? t(file.status)}>
          {statusLabels[file.status]}
        </span>
        {repositoryFileContentKind(file) === 'binary' ? <Binary size={14} /> : <File size={14} />}
        <span>
          <strong>{file.name}</strong>
          {(viewMode === 'flat' || transitionText) && (
            <small
              className={transitionText ? 'is-path-transition' : undefined}
              title={transitionDescription ?? undefined}
            >
              {transitionText ?? file.path}
            </small>
          )}
        </span>
      </div>
    )
  }

  return (
    <div
      ref={setWorkspaceElement}
      className="revision-changes-workspace"
      style={{
        gridTemplateColumns: diffVisible ? `${browserWidth}px 5px minmax(0, 1fr)` : 'minmax(0, 1fr)'
      }}
    >
      <aside className="revision-change-browser">
        <header className="revision-change-browser__header">
          <span>
            <strong>{t('changedFiles')}</strong>
            <small>
              {selectedObjectIds.length > 1
                ? t('status.filesSelected', {
                    count: files.length,
                    selectedCount: selectedObjectIds.length
                  })
                : t('status.fileCount', { count: files.length })}
            </small>
          </span>
          <div className="revision-change-browser__modes">
            {viewMode === 'tree' && (
              <>
                <button
                  type="button"
                  aria-label={t('expandAllChangeFolders')}
                  title={t('expandAllChangeFolders')}
                  disabled={allDirectoryPaths.length === 0}
                  onClick={() => setCollapsedDirectories(new Set())}
                >
                  <ChevronsDown size={14} />
                </button>
                <button
                  type="button"
                  aria-label={t('collapseAllChangeFolders')}
                  title={t('collapseAllChangeFolders')}
                  disabled={allDirectoryPaths.length === 0}
                  onClick={() => {
                    // 即使当前有搜索过滤，也折叠完整树；清除搜索后不会留下意外展开的目录。
                    setCollapsedDirectories(new Set(allDirectoryPaths))
                  }}
                >
                  <ChevronsUp size={14} />
                </button>
              </>
            )}
            <button
              type="button"
              aria-label={t('treeView')}
              title={t('treeView')}
              aria-pressed={viewMode === 'tree'}
              className={viewMode === 'tree' ? 'is-active' : ''}
              onClick={() => setMode('tree')}
            >
              <ListTree size={14} />
            </button>
            <button
              type="button"
              aria-label={t('flatView')}
              title={t('flatView')}
              aria-pressed={viewMode === 'flat'}
              className={viewMode === 'flat' ? 'is-active' : ''}
              onClick={() => setMode('flat')}
            >
              <List size={14} />
            </button>
          </div>
        </header>
        {showDiffSourceSelector && (
          <label className="revision-change-browser__baseline">
            <span>{t('compareAgainstParent')}</span>
            <SelectInput
              value={diffSourceRevision ?? revision.parentIds[0] ?? ''}
              aria-label={t('compareAgainstParent')}
              onChange={(event) => onDiffSourceRevisionChange?.(event.target.value)}
            >
              {revision.parentIds.map((parentId, index) => (
                <option key={parentId} value={parentId}>
                  {t('status.parentRevisionOption', {
                    index: index + 1,
                    id: parentId.slice(0, 8)
                  })}
                </option>
              ))}
            </SelectInput>
          </label>
        )}
        <label className="revision-change-browser__filter">
          <Search size={12} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('filterPathsOrFiles')}
            aria-label={t('filterRevisionChanges')}
          />
        </label>
        <div
          className="revision-change-browser__list"
          role="listbox"
          aria-label={t('revisionChangedFiles')}
          aria-multiselectable="true"
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'a') {
              event.preventDefault()
              setSelectedObjectIds(orderedObjectIds)
              setPrimaryObjectId(orderedObjectIds[0] ?? '')
              setContentSelectionAuthorized(orderedObjectIds.length > 0)
              selectionAnchorRef.current = orderedObjectIds[0] ?? null
            }
          }}
        >
          {loading ? null : error ? (
            <div className="revision-change-browser__empty is-error">
              <TriangleAlert size={18} />
              {error}
            </div>
          ) : visibleFiles.length === 0 ? (
            <div className="revision-change-browser__empty">
              <FileQuestion size={18} />
              {query ? t('noMatchingFiles') : (notice ?? t('revisionDiffDisplay_96ad'))}
            </div>
          ) : viewMode === 'flat' ? (
            visibleFiles.map((file) => renderFile(file))
          ) : (
            visibleRows.map((row) => {
              if (row.kind === 'file' && row.file) {
                return renderFile(row.file, row.depth)
              }
              const directoryFiles = files.filter((file) => row.descendantIds.includes(file.id))
              const selected = selectedSet.has(row.id)
              return (
                <div
                  key={row.id}
                  role="option"
                  aria-selected={selected}
                  aria-expanded={row.expanded}
                  className={`revision-change-row is-directory ${selected ? 'is-selected' : ''} ${primaryObjectId === row.id ? 'is-primary' : ''}`}
                  style={{ '--tree-depth': row.depth } as CSSProperties}
                  onClick={(event) => selectObject(row.id, event)}
                  onContextMenu={(event) => {
                    if (directoryFiles[0]) {
                      openContextMenu(row.id, directoryFiles, directoryFiles[0], event)
                    }
                  }}
                >
                  <button
                    type="button"
                    aria-label={`${row.expanded ? t('collapse') : t('expand')} ${row.name}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      setCollapsedDirectories((current) => {
                        const next = new Set(current)
                        if (next.has(row.path)) next.delete(row.path)
                        else next.add(row.path)
                        return next
                      })
                    }}
                  >
                    {row.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </button>
                  {row.expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
                  <strong>{row.name}</strong>
                  <small>{row.descendantIds.length}</small>
                </div>
              )
            })
          )}
        </div>
      </aside>

      {diffVisible && (
        <>
          <PaneResizer
            label={t('resizeTheRevisionFileList')}
            value={browserWidth}
            direction="right"
            container={workspaceElement}
            onChange={resizeBrowser}
            onReset={() => {
              setBrowserWidth(DEFAULT_BROWSER_WIDTH)
              updatePreferences({
                revisionChangesBrowserWidth: DEFAULT_BROWSER_WIDTH
              })
            }}
          />

          <section className="revision-diff-pane">
            <header className="revision-diff-pane__header">
              <span className="revision-diff-pane__file-icon" aria-hidden="true">
                {primaryDirectory ? (
                  <Folder size={15} />
                ) : primaryContentKind === 'binary' ? (
                  <Binary size={15} />
                ) : (
                  <File size={15} />
                )}
              </span>
              <div>
                <strong>{primaryFile?.name ?? primaryDirectory?.split('/').at(-1) ?? t('noFileSelected')}</strong>
                <small>
                  {primaryFile
                    ? primaryPathTransition
                      ? t('status.pathTransition', {
                          source: primaryPathTransition.sourcePath,
                          target: primaryPathTransition.targetPath
                        })
                      : changeFilePath(primaryFile)
                    : primaryDirectory
                      ? t('status.folderSelection', { path: primaryDirectory })
                      : t('status.selectLeftObject', { id: revision.shortId })}
                </small>
              </div>
              <DiffOptionsControl />
              {(primaryDiff && !diffLoading && !diffError && primaryContentKind !== 'binary') ||
              selectedObjectIds.length > 1 ? (
                <em className="revision-diff-pane__summary">
                  {primaryDiff && !diffLoading && !diffError && primaryContentKind !== 'binary' && (
                    <span className="diff-line-counts revision-diff-pane__line-counts">
                      <b>+{diffLineCounts.additions}</b>
                      <i>−{diffLineCounts.deletions}</i>
                    </span>
                  )}
                  {selectedObjectIds.length > 1 && (
                    <span>{t('status.selectedShowingPrimary', { count: selectedObjectIds.length })}</span>
                  )}
                </em>
              ) : null}
            </header>

            {diffLoading ? null : diffError ? (
              <div className="revision-diff-pane__empty is-error">
                <TriangleAlert size={28} />
                <strong>{t('unableToLoadRevisionDiff')}</strong>
                <span>{diffError}</span>
              </div>
            ) : notice && !primaryFile ? (
              <div className="revision-diff-pane__empty">
                <FileQuestion size={28} />
                <strong>{t('noPreviousDiffBaseline')}</strong>
                <span>{notice}</span>
              </div>
            ) : primaryDirectory ? (
              <div className="revision-diff-pane__empty">
                <Folder size={30} />
                <strong>{t('folderSelected')}</strong>
                <span>{t('foldersSingleTextDiffDescendant_0b83')}</span>
              </div>
            ) : !primaryFile ? (
              <div className="revision-diff-pane__empty">
                <FileQuestion size={28} />
                <strong>{t('selectFileViewDiff_ddf0')}</strong>
              </div>
            ) : previewModeActive && !preferences.binaryDiffVisible && !binaryPreview && !binaryPreviewLoading ? (
              <div className="revision-diff-pane__empty">
                <Binary size={30} />
                <strong>{t('binaryDiffHidden')}</strong>
                <span>{t('enableBinaryDiffInOptions')}</span>
              </div>
            ) : previewModeActive ? (
              <BinaryDiffPreview
                fileName={primaryFile.name}
                preview={binaryPreview}
                loading={binaryPreviewLoading}
                error={binaryPreviewError}
                size={primaryFile.size ? Number(primaryFile.size) : undefined}
              />
            ) : !primaryDiff?.patch ? (
              <div className="revision-diff-pane__empty">
                <File size={30} />
                <strong>{t('noTextDiffToDisplay')}</strong>
                <span>{changeFilePath(primaryFile)}</span>
              </div>
            ) : (
              <div
                className="revision-diff-pane__viewport"
                aria-label={t('status.revisionDiffOf', { name: primaryFile.name })}
              >
                <TextDiffView patch={primaryDiff.patch} filePath={changeFilePath(primaryFile)} themeType={themeType} />
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}

/** Tauri 结构化错误与标准 Error 在组件边界统一成可见中文详情。 */
function readPreviewError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error && 'message' in error) {
    return String(error.message)
  }
  return t('failedToLoadBinaryPreview')
}
