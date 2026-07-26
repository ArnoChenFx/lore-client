import {
  ChevronRight,
  Copy,
  ExternalLink,
  FileClock,
  FileDiff,
  FolderSearch,
  ListTree,
  RotateCcw,
  Undo2
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'

import { t } from '../../../i18n'
import { changeFilePath } from '../../../shared/lib'
import type {
  ChangeFile,
  ExternalDiffToolPreference,
  RepositoryFileReference,
  Revision,
  ToastMessage
} from '../../../types'

export interface RevisionFileMenuRequest {
  /** 按当前文件列表顺序保存选区，确保批量复制和还原结果稳定。 */
  files: RepositoryFileReference[]
  /** 最后交互的文件；单目标动作只作用于该文件。 */
  primaryFile: RepositoryFileReference
  /** 只有真实 Revision Diff 文件才能打开右侧变更。 */
  primaryChange?: ChangeFile
  /** 区分变更浏览器与完整文件树，避免显示指向当前视图的无效定位动作。 */
  source: 'changes' | 'tree'
  x: number
  y: number
  anchor: HTMLElement
}

interface RevisionFileContextMenuProps {
  request: RevisionFileMenuRequest
  revision: Revision
  repositoryPath: string
  externalDiffTools: ExternalDiffToolPreference[]
  onClose: () => void
  onOpenChange: (file: ChangeFile) => void
  onExternalDiff: (file: ChangeFile, tool: ExternalDiffToolPreference) => void
  onShowInTree: (files: RepositoryFileReference[], primaryFile: RepositoryFileReference) => void
  onRevealFile: (file: RepositoryFileReference) => void
  onHistory: (file: RepositoryFileReference) => void
  onResetFile: (files: RepositoryFileReference[], targetRevision: string, targetLabel: string) => void
  onNotify: (title: string, detail: string, tone?: ToastMessage['tone']) => void
}

const VIEWPORT_GAP = 8

/** 用户要求在两种 Revision 文件视图中保持一致的核心动作名称。 */
export function getRevisionFileMenuLabels() {
  return {
    history: t('fileHistory_2'),
    reset: t('restoreFileTo')
  } as const
}

/** 把菜单能力集中为纯函数，防止完整树未变更文件再次被整个菜单拒之门外。 */
export function revisionFileMenuCapabilities({
  source,
  hasPrimaryChange,
  fileCount
}: {
  source: RevisionFileMenuRequest['source']
  hasPrimaryChange: boolean
  fileCount: number
}) {
  return {
    canOpenChange: hasPrimaryChange,
    canShowInTree: source === 'changes',
    canOpenHistory: fileCount > 0,
    canReset: fileCount > 0
  }
}

/** 统一生成 Lore 使用的仓库相对路径，避免根目录文件产生多余斜杠。 */
export function getChangeFileRelativePath(file: RepositoryFileReference) {
  // 复用本地更改和 Revision 文件树的统一路径语义；根目录 "." 必须被消除，
  // 否则 Rust 的严格路径组件校验会把 `./file` 误判为非法路径。
  return changeFilePath(file)
}

/** 根据仓库根目录的格式拼接系统完整路径，同时兼容 Windows 与类 Unix 工作区。 */
export function getChangeFileFullPath(repositoryPath: string, file: RepositoryFileReference) {
  const separator = repositoryPath.includes('\\') ? '\\' : '/'
  const relativePath = getChangeFileRelativePath(file).replace(/[\\/]+/g, separator)
  return `${repositoryPath.replace(/[\\/]+$/, '')}${separator}${relativePath}`
}

function focusMenuItem(menu: HTMLElement | null, direction: 1 | -1 | 'first' | 'last') {
  if (!menu) return
  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>(':scope > button[role="menuitem"]:not(:disabled)'))
  if (items.length === 0) return

  if (direction === 'first') {
    items[0]?.focus()
    return
  }
  if (direction === 'last') {
    items.at(-1)?.focus()
    return
  }

  const currentIndex = items.findIndex((item) => item === document.activeElement)
  const nextIndex =
    currentIndex < 0
      ? direction === 1
        ? 0
        : items.length - 1
      : (currentIndex + direction + items.length) % items.length
  items[nextIndex]?.focus()
}

/**
 * 桌面式 Revision 文件菜单。
 *
 * 菜单通过 Portal 脱离可滚动 Inspector，测量真实尺寸后限制在视口内；
 * 子菜单独立定位，因此靠近窗口右侧时可以自动翻转到左边。
 */
export function RevisionFileContextMenu({
  request,
  revision,
  repositoryPath,
  externalDiffTools,
  onClose,
  onOpenChange,
  onExternalDiff,
  onShowInTree,
  onRevealFile,
  onHistory,
  onResetFile,
  onNotify
}: RevisionFileContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const externalTriggerRef = useRef<HTMLButtonElement>(null)
  const resetTriggerRef = useRef<HTMLButtonElement>(null)
  const submenuRef = useRef<HTMLDivElement>(null)
  const [submenuKind, setSubmenuKind] = useState<'external' | 'reset' | null>(null)
  const [menuPosition, setMenuPosition] = useState({
    left: request.x,
    top: request.y,
    ready: false
  })
  const [submenuPosition, setSubmenuPosition] = useState({
    left: 0,
    top: 0,
    ready: false
  })
  const primaryFile = request.primaryFile
  const fileCount = request.files.length
  const multiple = fileCount > 1
  const relativePaths = request.files.map(getChangeFileRelativePath)
  const fullPaths = request.files.map((file) => getChangeFileFullPath(repositoryPath, file))
  const primaryRelativePath = getChangeFileRelativePath(primaryFile)
  const firstParent = revision.parentIds?.[0]
  const parentLabel = revision.parentCount > 1 ? t('firstParentRevisionState') : t('parentRevisionState')
  const menuLabels = getRevisionFileMenuLabels()
  const capabilities = revisionFileMenuCapabilities({
    source: request.source,
    hasPrimaryChange: Boolean(request.primaryChange),
    fileCount
  })

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const bounds = menu.getBoundingClientRect()
    setMenuPosition({
      left: Math.max(VIEWPORT_GAP, Math.min(request.x, window.innerWidth - bounds.width - VIEWPORT_GAP)),
      top: Math.max(VIEWPORT_GAP, Math.min(request.y, window.innerHeight - bounds.height - VIEWPORT_GAP)),
      ready: true
    })
  }, [request.x, request.y])

  useLayoutEffect(() => {
    if (!submenuKind) return
    const trigger = submenuKind === 'external' ? externalTriggerRef.current : resetTriggerRef.current
    const submenu = submenuRef.current
    if (!trigger || !submenu) return
    const triggerBounds = trigger.getBoundingClientRect()
    const submenuBounds = submenu.getBoundingClientRect()
    const opensLeft = triggerBounds.right + submenuBounds.width > window.innerWidth - VIEWPORT_GAP
    setSubmenuPosition({
      left: opensLeft
        ? Math.max(VIEWPORT_GAP, triggerBounds.left - submenuBounds.width)
        : Math.min(window.innerWidth - submenuBounds.width - VIEWPORT_GAP, triggerBounds.right),
      top: Math.max(
        VIEWPORT_GAP,
        Math.min(triggerBounds.top - 4, window.innerHeight - submenuBounds.height - VIEWPORT_GAP)
      ),
      ready: true
    })
  }, [submenuKind, menuPosition])

  useEffect(() => {
    const frame = requestAnimationFrame(() => focusMenuItem(menuRef.current, 'first'))
    return () => cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    const handleOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !submenuRef.current?.contains(target)) {
        onClose()
      }
    }
    const handleContextMenu = (event: MouseEvent) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !submenuRef.current?.contains(target)) {
        onClose()
      }
    }
    const handleViewportChange = () => onClose()

    document.addEventListener('pointerdown', handleOutsidePointer, true)
    document.addEventListener('contextmenu', handleContextMenu, true)
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointer, true)
      document.removeEventListener('contextmenu', handleContextMenu, true)
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
      if (request.anchor.isConnected) {
        request.anchor.focus({ preventScroll: true })
      }
    }
  }, [onClose, request.anchor])

  const closeThen = (action: () => void) => {
    onClose()
    action()
  }

  const copyPath = async (value: string, label: string) => {
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

  const handleMainKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'c') {
      event.preventDefault()
      const values = event.shiftKey ? fullPaths : relativePaths
      const pathKind = event.shiftKey ? t('fullPath') : t('relativePath')
      closeThen(
        () =>
          void copyPath(
            values.join('\n'),
            multiple ? t('status.pathKindCount', { count: fileCount, kind: pathKind }) : pathKind
          )
      )
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      focusMenuItem(menuRef.current, event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      focusMenuItem(menuRef.current, event.key === 'Home' ? 'first' : 'last')
    } else if (
      event.key === 'ArrowRight' &&
      (document.activeElement === externalTriggerRef.current || document.activeElement === resetTriggerRef.current)
    ) {
      event.preventDefault()
      setSubmenuKind(document.activeElement === externalTriggerRef.current ? 'external' : 'reset')
      requestAnimationFrame(() => focusMenuItem(submenuRef.current, 'first'))
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault()
      onClose()
    }
  }

  const handleSubmenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      focusMenuItem(submenuRef.current, event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      focusMenuItem(submenuRef.current, event.key === 'Home' ? 'first' : 'last')
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setSubmenuKind(null)
      ;(submenuKind === 'external' ? externalTriggerRef.current : resetTriggerRef.current)?.focus()
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault()
      onClose()
    }
  }

  return createPortal(
    <>
      <div
        ref={menuRef}
        className="revision-file-menu"
        role="menu"
        aria-label={
          multiple
            ? t('status.revisionFileOperations', { count: fileCount })
            : t('status.fileOperationsNamed', { name: primaryFile.name })
        }
        onKeyDown={handleMainKeyDown}
        style={{
          left: menuPosition.left,
          top: menuPosition.top,
          visibility: menuPosition.ready ? 'visible' : 'hidden'
        }}
      >
        <header>
          <strong title={multiple ? request.files.map((file) => file.name).join('\n') : primaryFile.name}>
            {multiple ? t('status.selectedFilesCount', { count: fileCount }) : primaryFile.name}
          </strong>
          <small title={primaryRelativePath}>
            {multiple ? t('status.primaryFilePath', { path: primaryRelativePath }) : primaryRelativePath}
          </small>
        </header>
        <button
          type="button"
          role="menuitem"
          disabled={!capabilities.canOpenChange}
          title={capabilities.canOpenChange ? undefined : t('fileChangeCurrentRevision_826e')}
          onMouseEnter={() => setSubmenuKind(null)}
          onClick={() => {
            const change = request.primaryChange
            if (change) {
              closeThen(() => onOpenChange(change))
            }
          }}
        >
          <FileDiff size={15} />
          <span>
            {multiple ? t('openChangesForThePrimaryFile') : t('openChanges')}
            {!capabilities.canOpenChange && <small>{t('fileChangeRevision_f753')}</small>}
          </span>
        </button>
        {capabilities.canOpenChange && externalDiffTools.length > 0 && (
          <button
            ref={externalTriggerRef}
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={submenuKind === 'external'}
            onMouseEnter={() => setSubmenuKind('external')}
            onClick={() => setSubmenuKind((current) => (current === 'external' ? null : 'external'))}
          >
            <ExternalLink size={15} />
            <span>{t('externalDiff')}</span>
            <ChevronRight size={14} />
          </button>
        )}
        <button
          type="button"
          role="menuitem"
          disabled={!capabilities.canShowInTree}
          title={capabilities.canShowInTree ? undefined : t('currentFileAlreadyCompleteFile_57b9')}
          onMouseEnter={() => setSubmenuKind(null)}
          onClick={() => closeThen(() => onShowInTree(request.files, primaryFile))}
        >
          <ListTree size={15} />
          <span>{multiple ? t('status.showInFileTreeCount', { count: fileCount }) : t('showInFileTree')}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          onMouseEnter={() => setSubmenuKind(null)}
          onClick={() => closeThen(() => onRevealFile(primaryFile))}
        >
          <FolderSearch size={15} />
          <span>{multiple ? t('showPrimaryFileFileExplorer_f0f1') : t('showInFileExplorer')}</span>
        </button>

        <hr />

        <button
          type="button"
          role="menuitem"
          disabled={!capabilities.canOpenHistory}
          onMouseEnter={() => setSubmenuKind(null)}
          onClick={() => closeThen(() => onHistory(primaryFile))}
        >
          <FileClock size={15} />
          <span>{multiple ? t('status.primaryFileAction', { action: menuLabels.history }) : menuLabels.history}</span>
        </button>

        <button
          ref={resetTriggerRef}
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={submenuKind === 'reset'}
          disabled={!capabilities.canReset}
          onMouseEnter={() => {
            if (capabilities.canReset) setSubmenuKind('reset')
          }}
          onClick={() => {
            if (!capabilities.canReset) return
            setSubmenuKind((current) => (current === 'reset' ? null : 'reset'))
          }}
        >
          <RotateCcw size={15} />
          <span>{multiple ? t('status.restoreFilesToCount', { count: fileCount }) : menuLabels.reset}</span>
          <ChevronRight size={14} />
        </button>

        <hr />

        <button
          type="button"
          role="menuitem"
          onMouseEnter={() => setSubmenuKind(null)}
          onClick={() =>
            closeThen(
              () =>
                void copyPath(
                  relativePaths.join('\n'),
                  multiple
                    ? t('status.pathKindCount', { count: fileCount, kind: t('relativePath') })
                    : t('relativePath')
                )
            )
          }
        >
          <Copy size={15} />
          <span>{multiple ? t('status.copyRelativePathsCount', { count: fileCount }) : t('copyRelativePath')}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          onMouseEnter={() => setSubmenuKind(null)}
          onClick={() =>
            closeThen(
              () =>
                void copyPath(
                  fullPaths.join('\n'),
                  multiple ? t('status.pathKindCount', { count: fileCount, kind: t('fullPath') }) : t('fullPath')
                )
            )
          }
        >
          <Copy size={15} />
          <span>{multiple ? t('status.copyFullPathsCount', { count: fileCount }) : t('copyFullPath')}</span>
        </button>
      </div>

      {submenuKind && (
        <div
          ref={submenuRef}
          className="revision-file-menu revision-file-menu--submenu"
          role="menu"
          aria-label={submenuKind === 'external' ? t('externalDiff') : t('fileRestoreTarget')}
          onKeyDown={handleSubmenuKeyDown}
          style={{
            left: submenuPosition.left,
            top: submenuPosition.top,
            visibility: submenuPosition.ready ? 'visible' : 'hidden'
          }}
        >
          {submenuKind === 'external' ? (
            externalDiffTools.map((tool) => (
              <button
                key={tool.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  const change = request.primaryChange
                  if (change) closeThen(() => onExternalDiff(change, tool))
                }}
              >
                <ExternalLink size={15} />
                <span>
                  {tool.name}
                  {tool.primary && <small>{t('primaryExternalTool')}</small>}
                </span>
              </button>
            ))
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  closeThen(() =>
                    onResetFile(request.files, revision.id, t('status.revisionShortLabel', { id: revision.shortId }))
                  )
                }
              >
                <Undo2 size={15} />
                <span>
                  {t('currentRevisionState')}
                  <small>{revision.shortId}</small>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={!firstParent}
                title={
                  firstParent
                    ? t('status.restoreToTarget', { target: firstParent })
                    : t('usableParentRevisionLoreHistory_dba2')
                }
                onClick={() => {
                  if (!firstParent) return
                  closeThen(() => onResetFile(request.files, firstParent, `${parentLabel} ${firstParent.slice(0, 8)}`))
                }}
              >
                <Undo2 size={15} />
                <span>
                  {parentLabel}
                  <small>{firstParent?.slice(0, 8) ?? t('theCurrentRevisionHasNoParent')}</small>
                </span>
              </button>
            </>
          )}
        </div>
      )}
    </>,
    document.body
  )
}
