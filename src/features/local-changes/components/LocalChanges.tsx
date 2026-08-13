import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  File,
  FilePlus2,
  FileX2,
  Folder,
  FolderOpen,
  List,
  ListTree,
  LockKeyhole,
  LoaderCircle,
  Minus,
  MoveRight,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { useTranslation } from 'react-i18next'

import { useAdjustFromProps } from '../../../hooks/useAdjustFromProps'
import { useClientPreferences } from '../../../hooks/useClientPreferences'
import { t } from '../../../i18n'
import { fileLockOwnerLabel } from '../../../shared/lib'
import {
  buildChangeTreeRows,
  changeFileObjectId,
  changeFilePath,
  changeFilePathTransition,
  clampStageSplitRatio,
  isChangeDirectoryObjectId,
  resolveSelectedChangeFiles,
  selectChangeFile,
  type ChangeTreeRow,
  type ChangeViewMode
} from '../../../shared/lib'
import { IconButton } from '../../../shared/ui'
import type {
  Branch,
  ChangeFile,
  ConflictAction,
  ConflictSession,
  ExternalDiffToolPreference,
  LoreFileLock,
  ToastMessage
} from '../../../types'
import { ChangeContextMenu, type ChangeMenuRequest, type FileLockLoadState } from './ChangeContextMenu'
import { ConflictResolutionPanel } from './ConflictResolutionPanel'

interface LocalChangesProps {
  repositoryPath: string
  /** 当前仓库配置的提交身份；它始终优先于客户端默认身份。 */
  repositoryIdentity?: string
  /** 当前仓库的 Branch 快照；Merge 冲突默认消息用它把传入 Revision 还原为来源 Branch。 */
  branches: Branch[]
  /** 当前工作区附着的目标 Branch；Merge 冲突消息必须明确说明合并目标。 */
  currentBranch: string
  files: ChangeFile[]
  fileLocks?: LoreFileLock[]
  /** 按当前可见路径读取协作锁的状态；失败不能降级成“全部未锁定”。 */
  fileLockState?: FileLockLoadState
  /** 浏览器演示模式只能查看入口与说明，不得伪造 Lore 锁写入。 */
  lockAvailable?: boolean
  conflictSession: ConflictSession | null
  selectedIds: string[]
  busy: boolean
  refreshing: boolean
  refreshAvailable: boolean
  onRefresh: () => void
  onSelectionChange: (selectedIds: string[], primaryId: string | null) => void
  onStageFiles: (files: ChangeFile[], staged: boolean) => void
  onStageAll: (staged: boolean) => void
  onCreateRevision: (message: string) => void
  onOpenFile: (file: ChangeFile) => void
  externalDiffTools?: ExternalDiffToolPreference[]
  externalMergeTools?: ExternalDiffToolPreference[]
  onExternalDiff: (file: ChangeFile, tool: ExternalDiffToolPreference) => void
  onExternalMerge?: (file: ChangeFile, tool: ExternalDiffToolPreference) => void
  onRevealFile: (file: ChangeFile) => void
  onFileHistory: (file: ChangeFile, mode: 'timeline' | 'history') => void
  onDiscardFiles: (files: ChangeFile[]) => void
  onIgnoreFiles: (files: ChangeFile[], byExtension: boolean) => void
  onSavePatch: (files: ChangeFile[]) => void
  onAcquireFileLocks?: (files: ChangeFile[]) => void
  onReleaseFileLocks?: (files: ChangeFile[]) => void
  onOpenLockManager?: () => void
  onConflictAction: (action: Exclude<ConflictAction, 'abort'>, files: ChangeFile[]) => void
  onAbortConflict: () => void
  onNotify: (title: string, detail: string, tone?: ToastMessage['tone']) => void
}

/**
 * 为不同的 Lore 冲突操作选择本地化的收尾 Revision 默认消息。
 *
 * Lore 在产生冲突时不会可靠保留启动操作使用的消息，因此这里使用操作类型生成
 * 稳定建议值。只返回资源键，避免语言切换后继续显示旧语言文本。
 */
function conflictRevisionMessageKey(kind: ConflictSession['kind']) {
  if (kind === 'revert') return 'defaultRevertConflictRevisionMessage'
  return 'defaultConflictRevisionMessage'
}

/**
 * 尽量把 Lore 持久冲突状态中的传入 Revision 映射回用户可识别的来源 Branch。
 *
 * 本地 Branch 与远程 Branch 可能同时指向同一 Revision；Merge 的来源优先显示本地
 * Branch。若外部操作已移动了 Branch 指针，则退回稳定的短 Revision，仍不丢失来源。
 */
function mergeConflictSourceLabel(session: ConflictSession, branches: Branch[]) {
  const incomingRevision = session.incomingRevision
  if (!incomingRevision) return null

  const localSource = branches.find((branch) => !branch.remote && branch.latest === incomingRevision)
  const anySource = localSource ?? branches.find((branch) => branch.latest === incomingRevision)
  return anySource?.name ?? incomingRevision.slice(0, 8)
}

const DEFAULT_STAGE_SPLIT = 0.58
const MINIMUM_STAGE_PANEL_HEIGHT = 96

const statusInfo = {
  // 这里只保存语义键，实际文案在渲染期取值，避免语言切换后被冻结为模块加载时语言。
  modified: { labelKey: 'modified', short: 'M', icon: File },
  added: { labelKey: 'added', short: 'A', icon: FilePlus2 },
  deleted: { labelKey: 'deleted', short: 'D', icon: FileX2 },
  renamed: { labelKey: 'renamed', short: 'R', icon: MoveRight }
} as const

interface ChangeGroupProps {
  title: string
  files: ChangeFile[]
  rows: ChangeTreeRow[]
  viewMode: ChangeViewMode
  selectedIds: ReadonlySet<string>
  actionLabel: string
  stageDisabled: boolean
  lockByPath: ReadonlyMap<string, LoreFileLock>
  onToggleDirectory: (path: string) => void
  onObjectPointer: (objectId: string, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => void
  onContextMenu: (objectId: string, files: ChangeFile[], primary: ChangeFile, event: MouseEvent<HTMLElement>) => void
  onToggleStage: (files: ChangeFile[]) => void
}

/** 单个暂存分区；平铺与树视图最终都渲染同一种文件行语义。 */
function ChangeGroup({
  title,
  files,
  rows,
  viewMode,
  selectedIds,
  actionLabel,
  stageDisabled,
  lockByPath,
  onToggleDirectory,
  onObjectPointer,
  onContextMenu,
  onToggleStage
}: ChangeGroupProps) {
  const renderFile = (file: ChangeFile, depth = 0) => {
    const status = statusInfo[file.status]
    const StatusIcon = status.icon
    const objectId = changeFileObjectId(file.id)
    const selected = selectedIds.has(objectId)
    const fileLock = lockByPath.get(changeFilePath(file))
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
        className={`change-file-row ${selected ? 'is-selected' : ''} ${viewMode === 'tree' ? 'is-tree-row' : ''}`}
        style={{ '--tree-depth': depth } as CSSProperties}
        onClick={(event) => onObjectPointer(objectId, event)}
        onDoubleClick={(event) => {
          // 双击复用与行尾按钮完全相同的 Stage 入口，避免选择态与写操作走两套路径。
          event.preventDefault()
          if (!stageDisabled) onToggleStage([file])
        }}
        onContextMenu={(event) => onContextMenu(objectId, [file], file, event)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            // 行尾按钮只由 hover 显示；Enter 为键盘用户保留等价的 Stage 能力。
            event.preventDefault()
            if (!stageDisabled) onToggleStage([file])
            return
          }
          if (event.key === ' ') {
            event.preventDefault()
            onObjectPointer(objectId, event)
          }
        }}
        aria-keyshortcuts="Enter"
        title={t('status.doubleClickActionPath', { action: actionLabel, path: changeFilePath(file) })}
      >
        <span
          className={`change-file-row__status is-${file.status}`}
          title={transitionDescription ?? t(status.labelKey)}
        >
          <StatusIcon size={13} />
          <i>{status.short}</i>
        </span>
        <span className="change-file-row__name">
          <strong>
            <span>{file.name}</span>
            {fileLock && (
              <em
                className="change-file-row__lock"
                title={t('status.lockedByOwner', { owner: fileLockOwnerLabel(fileLock.owner) })}
                aria-label={t('status.lockedByOwner', { owner: fileLockOwnerLabel(fileLock.owner) })}
              >
                <LockKeyhole size={11} />
              </em>
            )}
            {file.conflict && (
              <em className={file.conflictUnresolved ? 'is-unresolved' : 'is-resolved'}>
                {file.conflictUnresolved ? t('conflictUnresolved') : t('conflictResolved')}
              </em>
            )}
          </strong>
          {(viewMode === 'flat' || transitionText) && (
            <small
              className={transitionText ? 'is-path-transition' : undefined}
              title={transitionDescription ?? undefined}
            >
              {transitionText ?? file.path}
            </small>
          )}
        </span>
        {file.binary && <em>{t('binary')}</em>}
        <button
          type="button"
          className="change-file-row__action"
          aria-label={t('status.actionName', { action: actionLabel, name: file.name })}
          title={t('status.actionColonPath', { action: actionLabel, path: changeFilePath(file) })}
          disabled={stageDisabled}
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation()
            if (!stageDisabled) onToggleStage([file])
          }}
          onDoubleClick={(event) => {
            // 双击按钮会先产生两次 click；阻止事件继续冒泡到文件行再次执行 Stage。
            event.stopPropagation()
          }}
        >
          {file.staged ? <Minus size={13} /> : <Plus size={13} />}
        </button>
      </div>
    )
  }

  return (
    <section className="change-group">
      <header>
        <span>
          <ChevronDown size={13} />
          <strong>{title}</strong>
          <small>{files.length}</small>
        </span>
      </header>
      <div className="change-group__body" role="listbox" aria-multiselectable="true">
        {files.length === 0 ? (
          <div className="change-group__empty">
            <Check size={15} />
            {t('noFilesInThisArea')}
          </div>
        ) : viewMode === 'flat' ? (
          files.map((file) => renderFile(file))
        ) : (
          rows.map((row) => {
            if (row.kind === 'file' && row.file) {
              return renderFile(row.file, row.depth)
            }
            const directoryFiles = files.filter((file) => row.descendantIds.includes(file.id))
            const selected = selectedIds.has(row.id)
            return (
              <div
                key={row.id}
                role="option"
                aria-selected={selected}
                aria-expanded={row.expanded}
                tabIndex={selected ? 0 : -1}
                className={`change-directory-row ${selected ? 'is-selected' : ''}`}
                style={{ '--tree-depth': row.depth } as CSSProperties}
                onClick={(event) => onObjectPointer(row.id, event)}
                onDoubleClick={(event) => {
                  // 目录动作使用已经展开好的明确后代文件集合，不隐式改变目录选区或折叠状态。
                  event.preventDefault()
                  if (!stageDisabled) onToggleStage(directoryFiles)
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  if (directoryFiles[0]) {
                    onContextMenu(row.id, directoryFiles, directoryFiles[0], event)
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    if (!stageDisabled) onToggleStage(directoryFiles)
                    return
                  }
                  if (event.key === ' ') {
                    event.preventDefault()
                    onObjectPointer(row.id, event)
                  }
                }}
                aria-keyshortcuts="Enter"
                title={t('status.doubleClickStageDirectory', {
                  action: actionLabel,
                  count: row.descendantIds.length
                })}
              >
                <button
                  type="button"
                  className="change-directory-row__toggle"
                  aria-label={`${row.expanded ? t('collapse') : t('expand')} ${row.name}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onToggleDirectory(row.path)
                  }}
                  onDoubleClick={(event) => {
                    // 展开入口拥有独立双击边界，不能把事件交给目录行执行 Stage。
                    event.stopPropagation()
                  }}
                >
                  {row.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
                {row.expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
                <strong>{row.name}</strong>
                <small>{row.descendantIds.length}</small>
                <button
                  type="button"
                  className="change-directory-row__action"
                  aria-label={t('status.actionName', { action: actionLabel, name: row.name })}
                  title={t('status.stageDirectoryFiles', {
                    action: actionLabel,
                    count: row.descendantIds.length
                  })}
                  tabIndex={-1}
                  disabled={stageDisabled}
                  onClick={(event) => {
                    // Stage 按钮是目录行内的独立命令，不能顺带改变对象选区或折叠状态。
                    event.stopPropagation()
                    if (!stageDisabled) onToggleStage(directoryFiles)
                  }}
                  onDoubleClick={(event) => {
                    event.stopPropagation()
                  }}
                >
                  {directoryFiles.every((file) => file.staged) ? <Minus size={13} /> : <Plus size={13} />}
                </button>
              </div>
            )
          })
        )}
      </div>
    </section>
  )
}

export function LocalChanges({
  repositoryPath,
  repositoryIdentity,
  branches,
  currentBranch,
  files,
  fileLocks = [],
  fileLockState = 'unavailable',
  lockAvailable = false,
  conflictSession,
  selectedIds,
  busy,
  refreshing,
  refreshAvailable,
  onRefresh,
  onSelectionChange,
  onStageFiles,
  onStageAll,
  onCreateRevision,
  onOpenFile,
  externalDiffTools = [],
  externalMergeTools = [],
  onExternalDiff,
  onExternalMerge = () => undefined,
  onRevealFile,
  onFileHistory,
  onDiscardFiles,
  onIgnoreFiles,
  onSavePatch,
  onAcquireFileLocks = () => undefined,
  onReleaseFileLocks = () => undefined,
  onOpenLockManager = () => undefined,
  onConflictAction,
  onAbortConflict,
  onNotify
}: LocalChangesProps) {
  const { t } = useTranslation()
  const { preferences, ready: preferencesReady, update: updatePreferences } = useClientPreferences()
  const [query, setQuery] = useState('')
  const [message, setMessage] = useState('')
  const [messageOverridden, setMessageOverridden] = useState(false)
  const [viewMode, setViewMode] = useState<ChangeViewMode>(preferences.localChangesView)
  const lockByPath = useMemo(() => new Map(fileLocks.map((lock) => [lock.path, lock] as const)), [fileLocks])
  const [collapsedDirectories, setCollapsedDirectories] = useState<Set<string>>(() => new Set())
  const [stageSplit, setStageSplit] = useState(preferences.localChangesStageSplit)
  const [menu, setMenu] = useState<ChangeMenuRequest | null>(null)
  const anchorRef = useRef<string | null>(null)
  const listsRef = useRef<HTMLDivElement>(null)
  const splitDragRef = useRef<{
    pointerId: number
    top: number
    availableHeight: number
    startRatio: number
  } | null>(null)
  const previousConflictSessionRef = useRef(Boolean(conflictSession))

  // 偏好就绪时同步本地视图状态；渲染期跟随（官方 adjusting state during render
  // 模式，useAdjustFromProps），避免 effect 同步 setState（react-compiler
  // EffectSetState）。key 前缀偏好就绪标记：就绪前保持固定值不调整，就绪后一次
  // 灌入；偏好值是稳定标量，值相同时不会重复调整，用户拖拽的分割比例不被触碰。
  const viewPreferenceKey = `${preferencesReady}:${preferences.localChangesView}|${preferences.localChangesStageSplit}`
  useAdjustFromProps(viewPreferenceKey, () => {
    setViewMode(preferences.localChangesView)
    setStageSplit(preferences.localChangesStageSplit)
  })

  useEffect(() => {
    const conflictWasActive = previousConflictSessionRef.current
    const conflictIsActive = Boolean(conflictSession)

    if (!conflictWasActive && conflictIsActive) {
      // 新冲突会话不能继承之前对普通提交消息输入框的“已编辑”状态。
      setMessageOverridden(false)
    } else if (conflictWasActive && !conflictIsActive) {
      // 创建收尾 Revision 或中止操作后清除冲突草稿，避免污染下一次普通提交。
      setMessage('')
      setMessageOverridden(false)
    }
    previousConflictSessionRef.current = conflictIsActive
  }, [conflictSession])

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

  // 未暂存优先，与 Fork 的工作区顺序一致，也决定 Shift 范围与全选的稳定顺序。
  const unstagedFiles = visibleFiles.filter((file) => !file.staged)
  const stagedFiles = visibleFiles.filter((file) => file.staged)
  const allUnstagedFiles = files.filter((file) => !file.staged)
  const allStagedFiles = files.filter((file) => file.staged)
  const unstagedRows = useMemo(
    () => buildChangeTreeRows(unstagedFiles, collapsedDirectories, 'unstaged'),
    [collapsedDirectories, unstagedFiles]
  )
  const stagedRows = useMemo(
    () => buildChangeTreeRows(stagedFiles, collapsedDirectories, 'staged'),
    [collapsedDirectories, stagedFiles]
  )
  const allTreeRows = useMemo(
    () => [
      ...buildChangeTreeRows(allUnstagedFiles, new Set(), 'unstaged'),
      ...buildChangeTreeRows(allStagedFiles, new Set(), 'staged')
    ],
    [allStagedFiles, allUnstagedFiles]
  )
  const allDirectoryPaths = useMemo(
    () => [
      // 上下暂存分区可能包含同名目录，而折叠状态按仓库相对路径共享；这里必须去重。
      ...new Set(allTreeRows.filter((row) => row.kind === 'directory').map((row) => row.path))
    ],
    [allTreeRows]
  )
  const orderedIds =
    viewMode === 'tree'
      ? [...unstagedRows, ...stagedRows].map((row) => row.id)
      : [...unstagedFiles, ...stagedFiles].map((file) => changeFileObjectId(file.id))
  const selectedSet = new Set(selectedIds)
  const selectedFiles = resolveSelectedChangeFiles(selectedIds, files, allTreeRows)
  const conflictFiles = files.filter((file) => file.conflict)
  const selectedConflictFiles = selectedFiles.filter((file) => file.conflict)
  const unresolvedConflictFiles = conflictFiles.filter((file) => file.conflictUnresolved)
  const conflictActive = Boolean(conflictSession || conflictFiles.length > 0)
  // 冲突会话要一直保留到 Revision 创建成功，但未解决数归零后必须开放唯一合法的收尾写操作。
  const conflictReadyToCommit = Boolean(
    conflictSession &&
    conflictSession.kind !== 'unknown' &&
    conflictFiles.length > 0 &&
    unresolvedConflictFiles.length === 0
  )
  const repositoryCommitIdentity = repositoryIdentity?.trim() ?? ''
  const defaultCommitIdentity = preferences.defaultIdentity.trim()
  const effectiveCommitIdentity = repositoryCommitIdentity || defaultCommitIdentity
  const mergeSourceLabel = conflictSession ? mergeConflictSourceLabel(conflictSession, branches) : null
  // Cherry-pick 必须保留精确来源 Revision 语义；短 ID 足以辨识，也避免默认消息被完整哈希淹没。
  const cherryPickSourceLabel =
    conflictSession?.kind === 'cherryPick' ? conflictSession.incomingRevision?.slice(0, 8) : null
  const defaultConflictRevisionMessage =
    conflictSession?.kind === 'merge' && mergeSourceLabel
      ? t('status.defaultMergeConflictRevisionMessage', {
          source: mergeSourceLabel,
          target: currentBranch
        })
      : conflictSession?.kind === 'cherryPick' && cherryPickSourceLabel
        ? t('status.defaultCherryPickConflictRevisionMessage', {
            source: cherryPickSourceLabel,
            target: currentBranch
          })
        : conflictSession
          ? t(conflictRevisionMessageKey(conflictSession.kind))
          : ''
  const effectiveRevisionMessage =
    conflictReadyToCommit && !messageOverridden && !message.trim() ? defaultConflictRevisionMessage : message
  const canCreateRevision =
    (!conflictActive || conflictReadyToCommit) &&
    files.some((file) => file.staged) &&
    Boolean(effectiveRevisionMessage.trim()) &&
    Boolean(effectiveCommitIdentity)
  const refreshLabel = refreshing
    ? t('scanningLocalChanges')
    : !refreshAvailable
      ? t('localChangesScannedDesktopApp_8f38')
      : busy
        ? t('repositoryOperationProgressLocalChanges_f53b')
        : t('scanAndRefreshLocalChanges')

  const setMode = (mode: ChangeViewMode) => {
    if (mode === 'flat' && selectedIds.some(isChangeDirectoryObjectId)) {
      // 平铺视图没有目录行；转换为等价文件对象后，操作范围仍然可见且可继续编辑。
      const fileObjectIds = selectedFiles.map((file) => changeFileObjectId(file.id))
      anchorRef.current = fileObjectIds[0] ?? null
      onSelectionChange(fileObjectIds, fileObjectIds[0] ?? null)
    }
    setViewMode(mode)
    updatePreferences({ localChangesView: mode })
  }

  const selectObject = (objectId: string, event: Pick<MouseEvent<HTMLElement>, 'ctrlKey' | 'metaKey' | 'shiftKey'>) => {
    const result = selectChangeFile(orderedIds, selectedIds, objectId, anchorRef.current, {
      toggle: event.ctrlKey || event.metaKey,
      range: event.shiftKey
    })
    anchorRef.current = result.anchorId
    const primaryId = result.selectedIds.includes(objectId) ? objectId : (result.selectedIds.at(-1) ?? null)
    onSelectionChange(result.selectedIds, primaryId)
  }

  const openMenu = (
    targetObjectId: string,
    targetFiles: ChangeFile[],
    primary: ChangeFile,
    event: MouseEvent<HTMLElement>
  ) => {
    event.preventDefault()
    const targetAlreadySelected = selectedSet.has(targetObjectId)
    const contextFiles = targetAlreadySelected && selectedFiles.length > 0 ? selectedFiles : targetFiles
    if (!targetAlreadySelected) {
      anchorRef.current = targetObjectId
      onSelectionChange([targetObjectId], targetObjectId)
    }
    setMenu({
      files: contextFiles,
      primary,
      x: event.clientX,
      y: event.clientY,
      anchor: event.currentTarget
    })
  }

  const handleListKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'a') {
      event.preventDefault()
      onSelectionChange(orderedIds, orderedIds[0] ?? null)
      return
    }
    if (event.key === 'Delete' && selectedFiles.length > 0 && !conflictActive) {
      event.preventDefault()
      onDiscardFiles(selectedFiles)
    }
  }

  const stageRatioFromPointer = (clientY: number) => {
    const drag = splitDragRef.current
    if (!drag) return stageSplit
    return clampStageSplitRatio(
      (clientY - drag.top) / drag.availableHeight,
      drag.availableHeight,
      MINIMUM_STAGE_PANEL_HEIGHT
    )
  }

  const beginStageResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const container = listsRef.current
    if (!container) return
    event.preventDefault()
    event.currentTarget.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
    const bounds = container.getBoundingClientRect()
    splitDragRef.current = {
      pointerId: event.pointerId,
      top: bounds.top,
      availableHeight: Math.max(1, bounds.height - 6),
      startRatio: stageSplit
    }
  }

  const moveStageResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (splitDragRef.current?.pointerId !== event.pointerId) return
    setStageSplit(stageRatioFromPointer(event.clientY))
  }

  const finishStageResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (splitDragRef.current?.pointerId !== event.pointerId) return
    const next = stageRatioFromPointer(event.clientY)
    setStageSplit(next)
    updatePreferences({ localChangesStageSplit: next })
    splitDragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const cancelStageResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = splitDragRef.current
    if (drag?.pointerId !== event.pointerId) return
    // 系统手势或窗口失焦中断拖动时恢复起始值，避免保存一次不完整操作。
    setStageSplit(drag.startRatio)
    splitDragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const adjustStageSplit = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const availableHeight = Math.max(1, (listsRef.current?.getBoundingClientRect().height ?? 300) - 6)
    const next = clampStageSplitRatio(
      stageSplit + (event.key === 'ArrowDown' ? 0.04 : -0.04),
      availableHeight,
      MINIMUM_STAGE_PANEL_HEIGHT
    )
    setStageSplit(next)
    updatePreferences({ localChangesStageSplit: next })
  }

  const resetStageSplit = () => {
    setStageSplit(DEFAULT_STAGE_SPLIT)
    updatePreferences({ localChangesStageSplit: DEFAULT_STAGE_SPLIT })
  }

  return (
    <section
      className={`local-changes ${conflictActive ? 'has-conflicts' : ''}`}
      tabIndex={0}
      onKeyDown={handleListKeyDown}
    >
      <header className="local-changes__header">
        <div className="local-changes__title">
          <span className="panel-header__eyebrow">{t('workspaceChanges')}</span>
          <strong>{t('localChanges')}</strong>
          <span>
            {selectedIds.length > 0
              ? t('status.filesSelected', { count: files.length, selectedCount: selectedIds.length })
              : t('status.fileCount', { count: files.length })}
          </span>
        </div>
        <label className="inline-search composite-input">
          <Search size={13} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('filterPathsOrFiles')}
            aria-label={t('filterLocalChanges')}
          />
        </label>
        <div className="local-changes__tools">
          <IconButton
            className="local-changes__refresh"
            icon={refreshing ? <LoaderCircle className="is-spinning" size={14} /> : <RefreshCw size={14} />}
            label={refreshLabel}
            disabled={!refreshAvailable || busy || refreshing}
            onClick={onRefresh}
          />
          <div className="change-view-switch" role="group" aria-label={t('changeListView')}>
            {viewMode === 'tree' && (
              <>
                <button
                  type="button"
                  aria-label={t('expandAllLocalChangeFolders')}
                  title={t('expandAllLocalChangeFolders')}
                  disabled={allDirectoryPaths.length === 0}
                  onClick={() => {
                    // 批量展开只改变目录可见性，文件与目录的独立选区、搜索和主对象保持原样。
                    setCollapsedDirectories(new Set())
                  }}
                >
                  <ChevronsDown size={14} />
                </button>
                <button
                  type="button"
                  aria-label={t('collapseAllLocalChangeFolders')}
                  title={t('collapseAllLocalChangeFolders')}
                  disabled={allDirectoryPaths.length === 0}
                  onClick={() => {
                    // 使用完整快照而非当前搜索结果，清除筛选后也不会意外展开未命中的目录。
                    setCollapsedDirectories(new Set(allDirectoryPaths))
                  }}
                >
                  <ChevronsUp size={14} />
                </button>
              </>
            )}
            <button
              type="button"
              className={viewMode === 'tree' ? 'is-active' : ''}
              aria-pressed={viewMode === 'tree'}
              aria-label={t('treeView')}
              onClick={() => setMode('tree')}
              title={t('treeView')}
            >
              <ListTree size={14} />
            </button>
            <button
              type="button"
              className={viewMode === 'flat' ? 'is-active' : ''}
              aria-pressed={viewMode === 'flat'}
              aria-label={t('flatView')}
              onClick={() => setMode('flat')}
              title={t('flatView')}
            >
              <List size={14} />
            </button>
          </div>
          <IconButton
            className="diff-visibility-toggle"
            icon={preferences.localChangesDiffVisible ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
            label={t(preferences.localChangesDiffVisible ? 'hideDiffView' : 'showDiffView')}
            aria-pressed={preferences.localChangesDiffVisible}
            onClick={() =>
              updatePreferences({
                localChangesDiffVisible: !preferences.localChangesDiffVisible
              })
            }
          />
        </div>
      </header>

      <div className="local-changes__summary">
        <span>
          <i className={conflictReadyToCommit ? 'is-ready' : conflictActive ? 'is-conflict' : 'is-clean'} />
          {conflictReadyToCommit
            ? t('conflictsResolvedReadyToCreateRevision')
            : conflictActive
              ? t('conflictResolution')
              : t('workspaceIsClean')}
        </span>
        <span>
          <b>{unstagedFiles.length}</b> {t('unstaged')}
        </span>
        <span>
          <b>{stagedFiles.length}</b> {t('staged')}
        </span>
      </div>

      <ConflictResolutionPanel
        session={conflictSession}
        conflictFiles={conflictFiles}
        selectedConflictFiles={selectedConflictFiles}
        busy={busy}
        onAction={onConflictAction}
        onAbort={onAbortConflict}
      />

      <div
        ref={listsRef}
        className="local-changes__lists"
        style={{
          gridTemplateRows: `minmax(${MINIMUM_STAGE_PANEL_HEIGHT}px, ${stageSplit}fr) 6px minmax(${MINIMUM_STAGE_PANEL_HEIGHT}px, ${1 - stageSplit}fr)`
        }}
      >
        <div className="change-list-section">
          <div className="change-group-toolbar">
            <span>{t('unstaged')}</span>
            <button type="button" disabled={conflictActive} onClick={() => onStageAll(true)}>
              {t('stageAll')}
            </button>
          </div>
          <ChangeGroup
            title={t('workspace')}
            files={unstagedFiles}
            rows={unstagedRows}
            viewMode={viewMode}
            selectedIds={selectedSet}
            actionLabel={t('stage')}
            stageDisabled={conflictActive}
            lockByPath={lockByPath}
            onToggleDirectory={(path) =>
              setCollapsedDirectories((current) => {
                const next = new Set(current)
                if (next.has(path)) next.delete(path)
                else next.add(path)
                return next
              })
            }
            onObjectPointer={selectObject}
            onContextMenu={openMenu}
            onToggleStage={(directoryFiles) => onStageFiles(directoryFiles, true)}
          />
        </div>
        <div
          className="stage-split-resizer"
          role="separator"
          aria-label={t('resizeTheUnstagedAndStagedAreas')}
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(stageSplit * 100)}
          tabIndex={0}
          title={t('dragResizeAreaHeightDouble_4185')}
          onPointerDown={beginStageResize}
          onPointerMove={moveStageResize}
          onPointerUp={finishStageResize}
          onPointerCancel={cancelStageResize}
          onKeyDown={adjustStageSplit}
          onDoubleClick={resetStageSplit}
        />
        <div className="change-list-section">
          <div className="change-group-toolbar">
            <span>{t('staged')}</span>
            <button type="button" disabled={conflictActive} onClick={() => onStageAll(false)}>
              {t('cancelAll')}
            </button>
          </div>
          <ChangeGroup
            title={t('pendingCommit')}
            files={stagedFiles}
            rows={stagedRows}
            viewMode={viewMode}
            selectedIds={selectedSet}
            actionLabel={t('unstage')}
            stageDisabled={conflictActive}
            lockByPath={lockByPath}
            onToggleDirectory={(path) =>
              setCollapsedDirectories((current) => {
                const next = new Set(current)
                if (next.has(path)) next.delete(path)
                else next.add(path)
                return next
              })
            }
            onObjectPointer={selectObject}
            onContextMenu={openMenu}
            onToggleStage={(directoryFiles) => onStageFiles(directoryFiles, false)}
          />
        </div>
      </div>

      <footer className="revision-composer">
        <div className="revision-composer__label">
          <span>
            <strong>{t('createRevision')}</strong>
            <small>{t('status.stagedFileCount', { count: files.filter((file) => file.staged).length })}</small>
          </span>
        </div>
        <div className="revision-composer__input">
          <textarea
            value={effectiveRevisionMessage}
            onChange={(event) => {
              setMessage(event.target.value)
              // 用户一旦编辑（包括主动清空）便不再自动回填，保证默认消息只是建议值。
              setMessageOverridden(true)
            }}
            placeholder={t('describeTheIntentOfThisRevision')}
            rows={2}
          />
          <div>
            {effectiveCommitIdentity ? (
              <span
                title={
                  repositoryCommitIdentity
                    ? t('useIdentityRepositoryLoreConfig_a1d5')
                    : t('repositoryIdentityClientDefaultUsed_c1ed')
                }
              >
                <Check size={12} />
                {repositoryCommitIdentity
                  ? t('status.commitIdentityRepository', { identity: effectiveCommitIdentity })
                  : t('status.commitIdentityClientDefault', { identity: effectiveCommitIdentity })}
              </span>
            ) : (
              <span
                className="revision-composer__identity-warning"
                title={t('setIdentityRepositoryConfigurationConfigure_a944')}
              >
                <ShieldAlert size={12} />
                {t('commitIdentityConfiguredCreateRevision_ce67')}
              </span>
            )}
            <button
              type="button"
              disabled={!canCreateRevision}
              onClick={() => {
                onCreateRevision(effectiveRevisionMessage.trim())
                setMessage('')
                setMessageOverridden(false)
              }}
            >
              {t('createRevision')}
            </button>
          </div>
        </div>
      </footer>

      {menu && (
        <ChangeContextMenu
          request={menu}
          repositoryPath={repositoryPath}
          busy={busy}
          fileLocks={fileLocks}
          fileLockState={fileLockState}
          lockAvailable={lockAvailable}
          mutationDisabled={conflictActive}
          externalDiffTools={externalDiffTools}
          externalMergeTools={externalMergeTools}
          onClose={() => setMenu(null)}
          onOpen={onOpenFile}
          onExternalDiff={onExternalDiff}
          onExternalMerge={onExternalMerge}
          onReveal={onRevealFile}
          onHistory={onFileHistory}
          onStage={onStageFiles}
          onDiscard={onDiscardFiles}
          onStageAll={() => onStageAll(true)}
          onIgnore={onIgnoreFiles}
          onSavePatch={onSavePatch}
          onAcquireLocks={onAcquireFileLocks}
          onReleaseLocks={onReleaseFileLocks}
          onOpenLockManager={onOpenLockManager}
          onNotify={onNotify}
        />
      )}
    </section>
  )
}
