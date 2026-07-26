import {
  Archive,
  ChevronRight,
  ClipboardCopy,
  Clock3,
  ExternalLink,
  Eye,
  FileClock,
  FileDown,
  FileX2,
  FolderOpen,
  LockKeyhole,
  LockKeyholeOpen,
  Minus,
  Plus,
  Save,
  Settings2,
  ShieldOff
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'

import { t } from '../../../i18n'
import { fileLockOwnerLabel } from '../../../shared/lib'
import { changeFilePath } from '../../../shared/lib'
import type { ContextMenuPoint } from '../../../shared/ui'
import type { ChangeFile, ExternalDiffToolPreference, LoreFileLock, ToastMessage } from '../../../types'

export type ChangeMenuRequest = {
  files: ChangeFile[]
  primary: ChangeFile
} & ContextMenuPoint

export type FileLockLoadState = 'loading' | 'ready' | 'unavailable'

interface ChangeContextMenuProps {
  request: ChangeMenuRequest
  repositoryPath: string
  busy: boolean
  fileLocks: LoreFileLock[]
  fileLockState: FileLockLoadState
  lockAvailable: boolean
  /** 冲突会话期间只禁止普通工作区写入；打开、历史和导出补丁等只读动作仍可使用。 */
  mutationDisabled?: boolean
  externalDiffTools: ExternalDiffToolPreference[]
  externalMergeTools: ExternalDiffToolPreference[]
  onClose: () => void
  onOpen: (file: ChangeFile) => void
  onExternalDiff: (file: ChangeFile, tool: ExternalDiffToolPreference) => void
  onExternalMerge: (file: ChangeFile, tool: ExternalDiffToolPreference) => void
  onReveal: (file: ChangeFile) => void
  onHistory: (file: ChangeFile, mode: 'timeline' | 'history') => void
  onStage: (files: ChangeFile[], staged: boolean) => void
  onDiscard: (files: ChangeFile[]) => void
  onStageAll: () => void
  onIgnore: (files: ChangeFile[], byExtension: boolean) => void
  onSavePatch: (files: ChangeFile[]) => void
  onAcquireLocks: (files: ChangeFile[]) => void
  onReleaseLocks: (files: ChangeFile[]) => void
  onOpenLockManager: () => void
  onNotify: (title: string, detail: string, tone?: ToastMessage['tone']) => void
}

const VIEWPORT_GAP = 8

export interface ChangeFileLockSelection {
  /** 当前冻结选区中至少存在一条真实锁记录的文件。 */
  lockedFiles: ChangeFile[]
  /** 当前冻结选区中可获取锁的文件；删除路径不能创建新的协作意图。 */
  acquirableFiles: ChangeFile[]
  /** 当前冻结选区命中的全部锁，保留同一路径的多个 Owner。 */
  locks: LoreFileLock[]
  /** 未锁定但因已删除而不能再获取锁的文件。 */
  deletedUnlockedFiles: ChangeFile[]
}

/**
 * 把文件选区与锁事件合并为菜单动作模型。
 *
 * 同一路径可能返回多个 Owner，不能使用单值 Map 丢失所有者；动作只按路径集合发送，
 * Release 的最终授权仍由 Rust 留空 Owner 后交给 Lore 当前凭据判断。
 */
export function resolveChangeFileLockSelection(
  files: ChangeFile[],
  fileLocks: LoreFileLock[]
): ChangeFileLockSelection {
  const selectedPaths = new Set(files.map(changeFilePath))
  const locks = fileLocks.filter((lock) => selectedPaths.has(lock.path))
  const lockedPaths = new Set(locks.map((lock) => lock.path))

  return {
    lockedFiles: files.filter((file) => lockedPaths.has(changeFilePath(file))),
    acquirableFiles: files.filter((file) => file.status !== 'deleted' && !lockedPaths.has(changeFilePath(file))),
    locks,
    deletedUnlockedFiles: files.filter((file) => file.status === 'deleted' && !lockedPaths.has(changeFilePath(file)))
  }
}

/** 父级菜单项禁用时禁止展开对应子菜单，避免禁用态仍可点到子项。 */
export function canOpenChangeContextSubmenu(
  submenu: 'external' | 'ignore' | 'lock',
  options: { textFileCount: number; busy: boolean }
): boolean {
  // 锁子菜单即使不可写也要展示加载失败、桌面能力限制和全局管理入口。
  if (submenu === 'lock') return true
  // 外部 Diff 支持二进制和缺失侧；即使尚未配置工具，也要保留进入设置的入口。
  if (submenu === 'external') return true
  return !options.busy
}

/** 本地更改文件菜单，批量动作始终使用打开菜单时冻结的文件集合。 */
export function ChangeContextMenu({
  request,
  repositoryPath,
  busy,
  fileLocks,
  fileLockState,
  lockAvailable,
  mutationDisabled = false,
  externalDiffTools,
  externalMergeTools,
  onClose,
  onOpen,
  onExternalDiff,
  onExternalMerge,
  onReveal,
  onHistory,
  onStage,
  onDiscard,
  onStageAll,
  onIgnore,
  onSavePatch,
  onAcquireLocks,
  onReleaseLocks,
  onOpenLockManager,
  onNotify
}: ChangeContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [submenu, setSubmenu] = useState<'external' | 'merge' | 'ignore' | 'lock' | null>(null)
  const [position, setPosition] = useState({
    left: request.x,
    top: request.y,
    ready: false,
    opensLeft: false
  })

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const bounds = menu.getBoundingClientRect()
    const left = Math.max(VIEWPORT_GAP, Math.min(request.x, window.innerWidth - bounds.width - VIEWPORT_GAP))
    setPosition({
      left,
      top: Math.max(VIEWPORT_GAP, Math.min(request.y, window.innerHeight - bounds.height - VIEWPORT_GAP)),
      ready: true,
      opensLeft: left + bounds.width + 260 > window.innerWidth
    })
  }, [request])

  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      menuRef.current?.querySelector<HTMLButtonElement>(':scope > button[role="menuitem"]:not(:disabled)')?.focus()
    )
    return () => cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    const handlePointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose()
    }
    const handleViewport = () => onClose()
    document.addEventListener('pointerdown', handlePointer, true)
    window.addEventListener('resize', handleViewport)
    window.addEventListener('scroll', handleViewport, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointer, true)
      window.removeEventListener('resize', handleViewport)
      window.removeEventListener('scroll', handleViewport, true)
      if (request.anchor.isConnected) {
        request.anchor.focus({ preventScroll: true })
      }
    }
  }, [onClose, request.anchor])

  const closeThen = (action: () => void) => {
    onClose()
    action()
  }

  const copyText = async (value: string, label: string) => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error(t('currentRuntimeWriteClipboard_0377'))
      }
      await navigator.clipboard.writeText(value)
      onNotify(t('status.labelCopied', { label }), value, 'success')
    } catch (error) {
      onNotify(
        t('status.labelCopyFailed', { label }),
        error instanceof Error ? error.message : t('unableToAccessTheSystemClipboard'),
        'warning'
      )
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (submenu) {
        setSubmenu(null)
      } else {
        onClose()
      }
      return
    }
    if (event.key === 'Tab') {
      onClose()
      return
    }
    if (event.key === 'ArrowLeft' && submenu) {
      event.preventDefault()
      setSubmenu(null)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? []
    )
    const current = items.findIndex((item) => item === document.activeElement)
    const delta = event.key === 'ArrowDown' ? 1 : -1
    const next = current < 0 ? (delta > 0 ? 0 : items.length - 1) : (current + delta + items.length) % items.length
    items[next]?.focus()
  }

  const { files, primary } = request
  const single = files.length === 1
  const unstaged = files.filter((file) => !file.staged)
  const staged = files.filter((file) => file.staged)
  const textFiles = files.filter((file) => !file.binary)
  const canOpenExternalSubmenu = canOpenChangeContextSubmenu('external', {
    textFileCount: textFiles.length,
    busy
  })
  const canOpenIgnoreSubmenu = canOpenChangeContextSubmenu('ignore', {
    textFileCount: textFiles.length,
    busy: busy || mutationDisabled
  })
  const allHaveExtension = files.every((file) => file.name.includes('.'))
  const separator = repositoryPath.includes('\\') ? '\\' : '/'
  const relativePaths = files.map(changeFilePath)
  const fullPaths = relativePaths.map(
    (path) => `${repositoryPath.replace(/[\\/]+$/, '')}${separator}${path.replaceAll('/', separator)}`
  )

  const openSubmenu = (next: 'external' | 'merge' | 'ignore' | 'lock') => {
    const capability = next === 'merge' ? 'external' : next
    if (!canOpenChangeContextSubmenu(capability, { textFileCount: textFiles.length, busy: busy || mutationDisabled }))
      return
    setSubmenu(next)
  }

  const toggleSubmenu = (next: 'external' | 'merge' | 'ignore' | 'lock') => {
    const capability = next === 'merge' ? 'external' : next
    if (!canOpenChangeContextSubmenu(capability, { textFileCount: textFiles.length, busy: busy || mutationDisabled }))
      return
    setSubmenu((current) => (current === next ? null : next))
  }

  const lockSelection = resolveChangeFileLockSelection(files, fileLocks)
  const lockStateReady = lockAvailable && fileLockState === 'ready'
  const canMutateLocks = lockStateReady && !busy
  const primaryLocks = lockSelection.locks.filter((lock) => lock.path === changeFilePath(primary))
  const lockSummary = !lockAvailable
    ? t('collaborativeLocksRequireDesktop')
    : fileLockState === 'loading'
      ? t('collaborativeLockStatusLoading')
      : fileLockState === 'unavailable'
        ? t('collaborativeLockStatusUnavailable')
        : single && primaryLocks.length === 1
          ? t('status.lockOwnerBranch', {
              owner: fileLockOwnerLabel(primaryLocks[0].owner),
              branch: primaryLocks[0].branch
            })
          : single && primaryLocks.length > 1
            ? t('status.collaborativeLockOwners', {
                count: primaryLocks.length,
                branch: primaryLocks[0].branch
              })
            : single && primary.status === 'deleted'
              ? t('deletedFileCannotAcquireCollaborativeLock')
              : single
                ? t('collaborativeLockAvailable')
                : t('status.collaborativeLockSelection', {
                    locked: lockSelection.lockedFiles.length,
                    available: lockSelection.acquirableFiles.length,
                    deleted: lockSelection.deletedUnlockedFiles.length
                  })

  const acquireSelectedLocks = () => {
    if (!canMutateLocks || lockSelection.acquirableFiles.length === 0) return
    if (
      lockSelection.acquirableFiles.length > 1 &&
      !window.confirm(
        t('confirm.acquireCollaborativeLocks', {
          count: lockSelection.acquirableFiles.length
        })
      )
    ) {
      return
    }
    closeThen(() => onAcquireLocks(lockSelection.acquirableFiles))
  }

  const releaseSelectedLocks = () => {
    if (!canMutateLocks || lockSelection.lockedFiles.length === 0) return
    if (
      !window.confirm(
        t('confirm.releaseOwnCollaborativeLocks', {
          count: lockSelection.lockedFiles.length
        })
      )
    ) {
      return
    }
    closeThen(() => onReleaseLocks(lockSelection.lockedFiles))
  }

  return createPortal(
    <div
      ref={menuRef}
      className={`revision-file-menu version-context-menu change-context-menu ${position.opensLeft ? 'opens-left' : ''}`}
      role="menu"
      aria-label={t('status.localChangesContext', { count: files.length })}
      onKeyDown={handleKeyDown}
      style={{
        left: position.left,
        top: position.top,
        visibility: position.ready ? 'visible' : 'hidden'
      }}
    >
      <header>
        <strong title={single ? changeFilePath(primary) : undefined}>
          {single ? primary.name : t('status.fileCount', { count: files.length })}
        </strong>
        <small>
          {single
            ? changeFilePath(primary)
            : t('status.stagedAndUnstaged', { staged: staged.length, unstaged: unstaged.length })}
        </small>
      </header>
      <button
        type="button"
        role="menuitem"
        disabled={!single || primary.status === 'deleted'}
        onClick={() => closeThen(() => onOpen(primary))}
      >
        <Eye size={15} />
        <span>
          {t('open')}
          {!single && <small>{t('onlyASingleFileIsSupported')}</small>}
          {primary.status === 'deleted' && <small>{t('fileWasDeletedWorkspace_10ac')}</small>}
        </span>
      </button>
      {externalDiffTools.length > 0 && (
        <div
          className="context-submenu-host"
          onPointerEnter={() => openSubmenu('external')}
          onPointerLeave={() => setSubmenu(null)}
        >
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={submenu === 'external'}
            disabled={!canOpenExternalSubmenu}
            onFocus={() => openSubmenu('external')}
            onClick={() => toggleSubmenu('external')}
          >
            <ExternalLink size={15} />
            <span>{t('externalDiff')}</span>
            <ChevronRight size={13} />
          </button>
          {canOpenExternalSubmenu && submenu === 'external' && (
            <div className="context-submenu" role="menu">
              {externalDiffTools.map((tool) => (
                <button
                  key={tool.id}
                  type="button"
                  role="menuitem"
                  onClick={() => closeThen(() => onExternalDiff(primary, tool))}
                >
                  <ExternalLink size={14} />
                  <span>
                    {tool.name}
                    {tool.primary && <small>{t('primaryExternalTool')}</small>}
                    {!single && <small>{t('status.selectedShowingPrimary', { count: files.length })}</small>}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {primary.conflict && externalMergeTools.length > 0 && (
        <div
          className="context-submenu-host"
          onPointerEnter={() => openSubmenu('merge')}
          onPointerLeave={() => setSubmenu(null)}
        >
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={submenu === 'merge'}
            onFocus={() => openSubmenu('merge')}
            onClick={() => toggleSubmenu('merge')}
          >
            <ExternalLink size={15} />
            <span>{t('externalMerge')}</span>
            <ChevronRight size={13} />
          </button>
          {submenu === 'merge' && (
            <div className="context-submenu" role="menu">
              {externalMergeTools.map((tool) => (
                <button
                  key={tool.id}
                  type="button"
                  role="menuitem"
                  onClick={() => closeThen(() => onExternalMerge(primary, tool))}
                >
                  <ExternalLink size={14} />
                  <span>
                    {tool.name}
                    {tool.primary && <small>{t('primaryExternalTool')}</small>}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        role="menuitem"
        disabled={textFiles.length === 0}
        title={textFiles.length === 0 ? t('binaryFilesTextPatches_d154') : undefined}
        onClick={() => closeThen(() => onSavePatch(textFiles))}
      >
        <Save size={14} />
        <span>{t('saveAsPatch')}</span>
      </button>
      <button type="button" role="menuitem" disabled={!single} onClick={() => closeThen(() => onReveal(primary))}>
        <FolderOpen size={15} />
        <span>{t('showInFileManager')}</span>
      </button>
      <hr />
      {/*<button
        type="button"
        role="menuitem"
        disabled={!single}
        onClick={() => closeThen(() => onHistory(primary, "timeline"))}
      >
        <Clock3 size={15} />
        <span>{t('fileTimeline_2')}</span>
      </button>*/}
      <button
        type="button"
        role="menuitem"
        disabled={!single}
        onClick={() => closeThen(() => onHistory(primary, 'history'))}
      >
        <FileClock size={15} />
        <span>{t('fileHistory_2')}</span>
      </button>
      <div
        className="context-submenu-host"
        onPointerEnter={() => openSubmenu('lock')}
        onPointerLeave={() => setSubmenu(null)}
      >
        <button
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={submenu === 'lock'}
          onFocus={() => openSubmenu('lock')}
          onClick={() => toggleSubmenu('lock')}
        >
          <LockKeyhole size={15} />
          <span>
            {t('collaborativeLocks')}
            <small>{lockSummary}</small>
          </span>
          <ChevronRight size={13} />
        </button>
        {submenu === 'lock' && (
          <div className="context-submenu context-submenu--locks" role="menu">
            <button type="button" role="menuitem" className="context-submenu__status" disabled>
              <LockKeyhole size={14} />
              <span>
                {lockSummary}
                <small>{t('collaborativeLockAdvisoryShort')}</small>
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!canMutateLocks || lockSelection.acquirableFiles.length === 0}
              onClick={acquireSelectedLocks}
            >
              <LockKeyhole size={14} />
              <span>
                {t('acquireCollaborativeLock')}
                <small>
                  {lockSelection.acquirableFiles.length > 0
                    ? t('status.fileCount', { count: lockSelection.acquirableFiles.length })
                    : lockSummary}
                </small>
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!canMutateLocks || lockSelection.lockedFiles.length === 0}
              onClick={releaseSelectedLocks}
            >
              <LockKeyholeOpen size={14} />
              <span>
                {t('releaseMyCollaborativeLocks')}
                <small>{t('currentCredentialsReleaseOwnLocksOnly')}</small>
              </span>
            </button>
            <button type="button" role="menuitem" onClick={() => closeThen(onOpenLockManager)}>
              <Settings2 size={14} />
              <span>{t('openCollaborativeLockManager')}</span>
            </button>
          </div>
        )}
      </div>
      <hr />
      {unstaged.length > 0 && (
        <button
          type="button"
          role="menuitem"
          disabled={busy || mutationDisabled}
          onClick={() => closeThen(() => onStage(unstaged, true))}
        >
          <Plus size={15} />
          <span>
            {unstaged.length > 1 ? `${t('stage')} ${t('status.fileCount', { count: unstaged.length })}` : t('stage')}
          </span>
        </button>
      )}
      {staged.length > 0 && (
        <button
          type="button"
          role="menuitem"
          disabled={busy || mutationDisabled}
          onClick={() => closeThen(() => onStage(staged, false))}
        >
          <Minus size={15} />
          <span>
            {staged.length > 1 ? `${t('unstage')} ${t('status.fileCount', { count: staged.length })}` : t('unstage')}
          </span>
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        className="is-danger"
        disabled={busy || mutationDisabled}
        onClick={() => closeThen(() => onDiscard(files))}
      >
        <FileX2 size={15} />
        <span>
          {files.length > 1 ? t('status.discardFilesEllipsis', { count: files.length }) : t('discardChanges')}
        </span>
      </button>
      <button type="button" role="menuitem" disabled={busy || mutationDisabled} onClick={() => closeThen(onStageAll)}>
        <FileDown size={15} />
        <span>{t('stageAll')}</span>
      </button>
      <div
        className="context-submenu-host"
        onPointerEnter={() => openSubmenu('ignore')}
        onPointerLeave={() => setSubmenu(null)}
      >
        <button
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={submenu === 'ignore'}
          disabled={!canOpenIgnoreSubmenu}
          onFocus={() => openSubmenu('ignore')}
          onClick={() => toggleSubmenu('ignore')}
        >
          <ShieldOff size={15} />
          <span>{t('ignore')}</span>
          <ChevronRight size={13} />
        </button>
        {canOpenIgnoreSubmenu && submenu === 'ignore' && (
          <div className="context-submenu" role="menu">
            <button type="button" role="menuitem" onClick={() => closeThen(() => onIgnore(files, false))}>
              <ShieldOff size={14} />
              <span>{t('ignoreSelectedPaths')}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!allHaveExtension}
              onClick={() => closeThen(() => onIgnore(files, true))}
            >
              <ShieldOff size={14} />
              <span>
                {t('ignoreSelectedExtensions')}
                {!allHaveExtension && <small>{t('selectionIncludesFilesWithoutExtension_9275')}</small>}
              </span>
            </button>
          </div>
        )}
      </div>
      {/*<button type="button" role="menuitem" disabled>
        <Archive size={15} />
        <span>
          {t('fileStash')}
          <small>Lore 当前没有可恢复的文件级 Stash</small>
        </span>
      </button>*/}
      <button
        type="button"
        role="menuitem"
        disabled={textFiles.length === 0}
        onClick={() => closeThen(() => onSavePatch(textFiles))}
      >
        <Save size={15} />
        <span>{t('saveAsPatch')}</span>
      </button>
      <hr />
      <button
        type="button"
        role="menuitem"
        onClick={() => closeThen(() => void copyText(relativePaths.join('\n'), t('relativePath')))}
      >
        <ClipboardCopy size={15} />
        <span>{t('copyPath')}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => closeThen(() => void copyText(fullPaths.join('\n'), t('fullPath')))}
      >
        <ClipboardCopy size={15} />
        <span>{t('copyFullPath')}</span>
      </button>
    </div>,
    document.body
  )
}
