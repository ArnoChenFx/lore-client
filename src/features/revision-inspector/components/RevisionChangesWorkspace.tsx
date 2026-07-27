import {
  Binary,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  FileCode2,
  FileQuestion,
  Folder,
  FolderOpen,
  List,
  ListTree,
  LoaderCircle,
  Search,
  TriangleAlert
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { useClientPreferences } from '../../../hooks/useClientPreferences'
import { t } from '../../../i18n'
import {
  binaryPreviewKind,
  buildChangeTreeRows,
  changeDirectoryPathFromObjectId,
  changeFileObjectId,
  changeFilePath,
  countUnifiedDiffLines,
  isChangeDirectoryObjectId,
  parseUnifiedDiff,
  resolveSelectedChangeFiles,
  selectChangeContext,
  selectChangeFile,
  type ChangeViewMode
} from '../../../shared/lib'
import { BinaryDiffPreview, DiffOptionsControl, PaneResizer, SelectInput } from '../../../shared/ui'
import type {
  BinaryDiffPreview as BinaryDiffPreviewData,
  BinaryFilePreview,
  ChangeFile,
  Revision,
  WorkingTreeDiff
} from '../../../types'

interface RevisionChangesWorkspaceProps {
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
  onLoadBinaryPreview?: (path: string, revision?: string) => Promise<BinaryFilePreview>
  onPrimaryFileChange?: (file: ChangeFile | null) => void
  onOpenContextMenu: (files: ChangeFile[], primaryFile: ChangeFile, event: MouseEvent<HTMLElement>) => void
}

const DEFAULT_BROWSER_WIDTH = 220

export interface RevisionWorkspaceSelectionRequest {
  nonce: number
  fileIds: string[]
  primaryFileId: string
  mode?: ChangeViewMode
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
   * 文件集合若在首次渲染时已经就绪，立即建立主选择，避免标题栏先短暂显示
   * “未选择文件”；后续 Revision 或惰性清单变化仍由下方 effect 重新同步。
   */
  const initialFileObjectId = files[0] ? changeFileObjectId(files[0].id) : ''
  const [selectedObjectIds, setSelectedObjectIds] = useState<string[]>(() =>
    initialFileObjectId ? [initialFileObjectId] : []
  )
  const [primaryObjectId, setPrimaryObjectId] = useState(initialFileObjectId)
  const [browserWidth, setBrowserWidth] = useState(preferences.revisionChangesBrowserWidth)
  const [binaryPreview, setBinaryPreview] = useState<BinaryDiffPreviewData | null>(null)
  const [binaryPreviewLoading, setBinaryPreviewLoading] = useState(false)
  const [binaryPreviewError, setBinaryPreviewError] = useState<string | null>(null)
  const [workspaceElement, setWorkspaceElement] = useState<HTMLDivElement | null>(null)
  const selectionAnchorRef = useRef<string | null>(null)
  const previewRequestCounter = useRef(0)
  const diffVisible = preferences.revisionChangesDiffVisible
  const showDiffSourceSelector = revision.parentIds.length > 1 && Boolean(onDiffSourceRevisionChange)

  const visibleFiles = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return files
    return files.filter((file) => changeFilePath(file).toLocaleLowerCase().includes(normalized))
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
  const primaryDirectory = changeDirectoryPathFromObjectId(primaryObjectId)
  const primaryDiff = primaryFile
    ? (diffs.find((diff) => diff.path.replaceAll('\\', '/') === changeFilePath(primaryFile)) ?? null)
    : null
  const diffLines = useMemo(() => (primaryDiff?.patch ? parseUnifiedDiff(primaryDiff.patch) : []), [primaryDiff?.patch])
  const diffLineCounts = useMemo(() => countUnifiedDiffLines(diffLines), [diffLines])
  const previewableKind = primaryFile ? binaryPreviewKind(changeFilePath(primaryFile)) : null

  useEffect(() => {
    if (!preferencesReady) return
    setViewMode(preferences.revisionChangesView)
    setBrowserWidth(preferences.revisionChangesBrowserWidth)
  }, [preferences.revisionChangesBrowserWidth, preferences.revisionChangesView, preferencesReady])

  useEffect(() => {
    const firstObjectId = files[0] ? changeFileObjectId(files[0].id) : ''
    setSelectedObjectIds(firstObjectId ? [firstObjectId] : [])
    setPrimaryObjectId(firstObjectId)
    selectionAnchorRef.current = firstObjectId || null
    setCollapsedDirectories(new Set())
  }, [files, revision.id])

  /** 把稳定主要选择上报给 App，使后端只读取这一条路径的真实 unified diff。 */
  useEffect(() => {
    onPrimaryFileChange?.(primaryFile)
  }, [onPrimaryFileChange, primaryFile])

  /**
   * 只为主选择读取可预览的前后版本。
   *
   * 目录、多选中的非主文件和不可预览资产都不会触发 Store 读取；快速切换对象时
   * 通过序号丢弃旧请求，避免旧内容短暂覆盖当前 Revision 选择。
   */
  useEffect(() => {
    previewRequestCounter.current += 1
    const requestId = previewRequestCounter.current
    setBinaryPreview(null)
    setBinaryPreviewError(null)

    if (!diffVisible || !preferences.binaryDiffVisible || !primaryFile || !previewableKind) {
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
      promise: Promise<BinaryFilePreview>
    }> = []
    const sourceRevision = diffSourceRevision ?? revision.parentIds[0]
    if (primaryFile.status !== 'added' && sourceRevision) {
      requests.push({
        side: 'before',
        promise: onLoadBinaryPreview(path, sourceRevision)
      })
    }
    if (primaryFile.status !== 'deleted') {
      requests.push({
        side: 'after',
        promise: onLoadBinaryPreview(path, revision.id)
      })
    }
    if (requests.length === 0) {
      setBinaryPreviewLoading(false)
      setBinaryPreviewError(t('changeReadablePreviewVersion_8fe5'))
      return
    }

    setBinaryPreviewLoading(true)
    void Promise.allSettled(requests.map((request) => request.promise))
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
          setBinaryPreview(next)
        } else {
          setBinaryPreviewError(errors.join('；') || t('loreReturnPreviewableFileContent_451e'))
        }
      })
      .finally(() => {
        if (requestId === previewRequestCounter.current) {
          setBinaryPreviewLoading(false)
        }
      })
  }, [
    diffVisible,
    onLoadBinaryPreview,
    preferences.binaryDiffVisible,
    previewableKind,
    primaryFile,
    revision.id,
    revision.parentIds,
    diffSourceRevision,
    t
  ])

  useEffect(() => {
    if (!selectionRequest) return
    const requestedIds = selectionRequest.fileIds
      .filter((fileId) => files.some((file) => file.id === fileId))
      .map(changeFileObjectId)
    const primaryId = files.some((file) => file.id === selectionRequest.primaryFileId)
      ? changeFileObjectId(selectionRequest.primaryFileId)
      : (requestedIds[0] ?? '')

    setSelectedObjectIds(requestedIds)
    setPrimaryObjectId(primaryId)
    selectionAnchorRef.current = primaryId || null
    if (selectionRequest.mode) {
      setViewMode(selectionRequest.mode)
      updatePreferences({ revisionChangesView: selectionRequest.mode })
    }
  }, [files, selectionRequest, updatePreferences])

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
    return (
      <div
        key={objectId}
        role="option"
        aria-selected={selected}
        tabIndex={selected ? 0 : -1}
        className={`revision-change-row is-file ${selected ? 'is-selected' : ''} ${primaryObjectId === objectId ? 'is-primary' : ''}`}
        style={{ '--tree-depth': depth } as CSSProperties}
        onClick={(event) => selectObject(objectId, event)}
        onContextMenu={(event) => openContextMenu(objectId, [file], file, event)}
      >
        <span className={`file-status is-${file.status}`}>{statusLabels[file.status]}</span>
        {file.binary ? <Binary size={14} /> : <FileCode2 size={14} />}
        <span>
          <strong>{file.name}</strong>
          {viewMode === 'flat' && <small>{file.path}</small>}
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
              selectionAnchorRef.current = orderedObjectIds[0] ?? null
            }
          }}
        >
          {loading ? (
            <div className="revision-change-browser__empty">
              <LoaderCircle className="is-spinning" size={18} />
              {t('loadingRevisionDiff')}
            </div>
          ) : error ? (
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
                ) : primaryFile?.binary ? (
                  <Binary size={15} />
                ) : (
                  <FileCode2 size={15} />
                )}
              </span>
              <div>
                <strong>{primaryFile?.name ?? primaryDirectory?.split('/').at(-1) ?? t('noFileSelected')}</strong>
                <small>
                  {primaryFile
                    ? changeFilePath(primaryFile)
                    : primaryDirectory
                      ? t('status.folderSelection', { path: primaryDirectory })
                      : t('status.selectLeftObject', { id: revision.shortId })}
                </small>
              </div>
              <DiffOptionsControl />
              {(primaryDiff && !diffLoading && !diffError && !primaryFile?.binary) || selectedObjectIds.length > 1 ? (
                <em className="revision-diff-pane__summary">
                  {primaryDiff && !diffLoading && !diffError && !primaryFile?.binary && (
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

            {diffLoading ? (
              <div className="revision-diff-pane__empty">
                <LoaderCircle className="is-spinning" size={28} />
                <strong>{t('loadingLoreRevisionDiff')}</strong>
              </div>
            ) : diffError ? (
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
            ) : (primaryFile.binary || previewableKind) && !preferences.binaryDiffVisible ? (
              <div className="revision-diff-pane__empty">
                <Binary size={30} />
                <strong>{t('binaryDiffHidden')}</strong>
                <span>{t('enableBinaryDiffInOptions')}</span>
              </div>
            ) : previewableKind ? (
              <BinaryDiffPreview
                fileName={primaryFile.name}
                preview={binaryPreview}
                loading={binaryPreviewLoading}
                error={binaryPreviewError}
                size={primaryFile.size ? Number(primaryFile.size) : undefined}
              />
            ) : primaryFile.binary || !primaryDiff?.patch ? (
              <div className="revision-diff-pane__empty">
                <Binary size={30} />
                <strong>
                  {primaryFile.binary ? t('inlinePreviewSupportedBinaryType_63f9') : t('noTextDiffToDisplay')}
                </strong>
                <span>
                  {primaryFile.binary
                    ? t('status.binaryFormatsSupported', { path: changeFilePath(primaryFile), size: primaryFile.size ?? t('unknownSize') })
                    : changeFilePath(primaryFile)}
                </span>
              </div>
            ) : (
              <div
                className="revision-diff-pane__viewport"
                aria-label={t('status.revisionDiffOf', { name: primaryFile.name })}
              >
                <div className="revision-diff-pane__columns" aria-hidden="true">
                  <span>{t('oldLines')}</span>
                  <span>{t('newLines')}</span>
                  <span>{t('content')}</span>
                </div>
                <code className="revision-diff-pane__code">
                  {diffLines.map((line) => (
                    <span key={line.id} className={`revision-diff-pane__line is-${line.kind}`}>
                      <i>{line.oldLine ?? ''}</i>
                      <i>{line.newLine ?? ''}</i>
                      <b aria-hidden="true">{line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '−' : ' '}</b>
                      <span>{line.content || ' '}</span>
                    </span>
                  ))}
                </code>
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
