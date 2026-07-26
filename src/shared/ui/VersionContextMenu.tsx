import {
  Archive,
  CheckCircle2,
  ClipboardCopy,
  Copy,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  History,
  LogIn,
  Plus,
  Radio,
  RotateCcw,
  Send,
  Tags
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'

import { t } from '../../i18n'
import type { Branch, BranchCreationSource, Revision, TagCreationSource, ToastMessage } from '../../types'

/** 触发菜单时立即保存坐标与焦点锚点，避免列表刷新后继续依赖 React 合成事件。 */
export interface ContextMenuPoint {
  x: number
  y: number
  anchor: HTMLElement
}

export type VersionMenuRequest =
  | ({ kind: 'revision'; revision: Revision } & ContextMenuPoint)
  | ({ kind: 'branch'; branch: Branch } & ContextMenuPoint)

interface VersionContextMenuProps {
  request: VersionMenuRequest
  currentBranch: string
  currentRevisionId?: string
  busy: boolean
  onClose: () => void
  onOpenRevision: (revision: Revision) => void
  onCheckoutRevision: (revision: Revision) => void
  onCherryPickRevision: (revision: Revision) => void
  onRevertRevision: (revision: Revision) => void
  onSwitchBranch: (branch: Branch) => void
  onPushBranch: (branch: Branch) => void
  onMergeBranch: (branch: Branch) => void
  onArchiveBranch: (branch: Branch) => void
  onOpenBranchRevision: (branch: Branch) => void
  onCreateBranch: (source: BranchCreationSource) => void
  onCreateTag: (source: TagCreationSource) => void
  onNotify: (title: string, detail: string, tone?: ToastMessage['tone']) => void
}

const VIEWPORT_GAP = 8

/** 生成可直接粘贴到问题单或聊天中的稳定修订摘要。 */
export function getRevisionClipboardInfo(revision: Revision) {
  const branchText =
    revision.branchPointers.length > 0
      ? revision.branchPointers.map((pointer) => pointer.name).join(', ')
      : t('noBranchPointer')
  return [
    revision.title,
    `${t('revisions')}: ${revision.id}`,
    `${t('author')}: ${revision.author}`,
    `${t('time')}: ${revision.timestamp}`,
    `${t('branches')}: ${branchText}`
  ].join('\n')
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
 * Revision 与 Branch 共用的桌面式上下文菜单。
 *
 * 菜单通过 Portal 脱离工作区网格和滚动容器，测量后限制在视口内；关闭时
 * 把焦点交还给右击锚点，让鼠标和键盘两条交互路径保持一致。
 */
export function VersionContextMenu({
  request,
  currentBranch,
  currentRevisionId,
  busy,
  onClose,
  onOpenRevision,
  onCheckoutRevision,
  onCherryPickRevision,
  onRevertRevision,
  onSwitchBranch,
  onPushBranch,
  onMergeBranch,
  onArchiveBranch,
  onOpenBranchRevision,
  onCreateBranch,
  onCreateTag,
  onNotify
}: VersionContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({
    left: request.x,
    top: request.y,
    ready: false
  })

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const bounds = menu.getBoundingClientRect()
    setPosition({
      left: Math.max(VIEWPORT_GAP, Math.min(request.x, window.innerWidth - bounds.width - VIEWPORT_GAP)),
      top: Math.max(VIEWPORT_GAP, Math.min(request.y, window.innerHeight - bounds.height - VIEWPORT_GAP)),
      ready: true
    })
  }, [request])

  useEffect(() => {
    const frame = requestAnimationFrame(() => focusMenuItem(menuRef.current, 'first'))
    return () => cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    const handleOutsidePointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose()
    }
    const handleContextMenu = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose()
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
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      focusMenuItem(menuRef.current, event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      focusMenuItem(menuRef.current, event.key === 'Home' ? 'first' : 'last')
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault()
      onClose()
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'c') {
      event.preventDefault()
      const value =
        request.kind === 'revision'
          ? event.shiftKey
            ? getRevisionClipboardInfo(request.revision)
            : request.revision.id
          : request.branch.name
      const label =
        request.kind === 'revision' ? (event.shiftKey ? t('revisionInformation') : t('revisionId')) : t('branchName')
      onClose()
      void copyText(value, label)
    }
  }

  const content =
    request.kind === 'revision' ? (
      <RevisionMenuItems
        revision={request.revision}
        currentBranch={currentBranch}
        currentRevisionId={currentRevisionId}
        busy={busy}
        closeThen={closeThen}
        copyText={copyText}
        onOpenRevision={onOpenRevision}
        onCheckoutRevision={onCheckoutRevision}
        onCherryPickRevision={onCherryPickRevision}
        onRevertRevision={onRevertRevision}
        onCreateBranch={onCreateBranch}
        onCreateTag={onCreateTag}
      />
    ) : request.branch.archived ? (
      <ArchivedBranchMenuItems
        branch={request.branch}
        busy={busy}
        closeThen={closeThen}
        copyText={copyText}
        onOpenBranchRevision={onOpenBranchRevision}
        onCreateTag={onCreateTag}
      />
    ) : (
      <BranchMenuItems
        branch={request.branch}
        currentBranch={currentBranch}
        busy={busy}
        closeThen={closeThen}
        copyText={copyText}
        onSwitchBranch={onSwitchBranch}
        onPushBranch={onPushBranch}
        onMergeBranch={onMergeBranch}
        onArchiveBranch={onArchiveBranch}
        onCreateBranch={onCreateBranch}
        onCreateTag={onCreateTag}
      />
    )

  const title = request.kind === 'revision' ? request.revision.title : request.branch.name
  const subtitle =
    request.kind === 'revision'
      ? t('status.revisionMeta', { id: request.revision.shortId, author: request.revision.author })
      : `${request.branch.archived ? t('status.archivedLocalBranch') : request.branch.remote ? t('remoteBranches') : t('localBranches')} · ${request.branch.latest?.slice(0, 8) || t('noRevisions')}`

  return createPortal(
    <div
      ref={menuRef}
      className="revision-file-menu version-context-menu"
      role="menu"
      aria-label={t('status.contextActionsFor', { title })}
      onKeyDown={handleKeyDown}
      style={{
        left: position.left,
        top: position.top,
        visibility: position.ready ? 'visible' : 'hidden'
      }}
    >
      <header>
        <strong title={title}>{title}</strong>
        <small>{subtitle}</small>
      </header>
      {content}
    </div>,
    document.body
  )
}

interface RevisionMenuItemsProps {
  revision: Revision
  currentBranch: string
  currentRevisionId?: string
  busy: boolean
  closeThen: (action: () => void) => void
  copyText: (value: string, label: string) => Promise<void>
  onOpenRevision: (revision: Revision) => void
  onCheckoutRevision: (revision: Revision) => void
  onCherryPickRevision: (revision: Revision) => void
  onRevertRevision: (revision: Revision) => void
  onCreateBranch: (source: BranchCreationSource) => void
  onCreateTag: (source: TagCreationSource) => void
}

function RevisionMenuItems({
  revision,
  currentBranch,
  currentRevisionId,
  busy,
  closeThen,
  copyText,
  onOpenRevision,
  onCheckoutRevision,
  onCherryPickRevision,
  onRevertRevision,
  onCreateBranch,
  onCreateTag
}: RevisionMenuItemsProps) {
  const isCurrentRevision = revision.id === currentRevisionId
  /*
   * History 可能包含合并进来的其他 Branch Revision。Lore 切换接口同时要求
   * Branch 和 Revision，因此优先使用指向该 Revision 的分支标签；只有没有
   * 指针标签时，才回退到当前 Branch 作为可达历史的上下文。
   */
  const sourceBranchLabels = revision.branchPointers
    .filter((pointer) => pointer.kind !== 'head')
    .map((pointer) => pointer.name)
  const sourceBranch =
    sourceBranchLabels.find((label) => label === currentBranch) ?? sourceBranchLabels[0] ?? currentBranch
  return (
    <>
      <button type="button" role="menuitem" onClick={() => closeThen(() => onOpenRevision(revision))}>
        <History size={15} />
        <span>{t('openInInspector')}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={busy || isCurrentRevision}
        title={
          isCurrentRevision
            ? t('currentInstanceAlreadyRevision_5171')
            : busy
              ? t('waitCurrentLoreOperationFinish_410e')
              : t('status.syncWorkspaceToRevision', { branch: currentBranch })
        }
        onClick={() => closeThen(() => onCheckoutRevision(revision))}
      >
        <LogIn size={15} />
        <span>
          {t('checkOut')}
          {(busy || isCurrentRevision) && (
            <small>{isCurrentRevision ? t('alreadyTheCurrentRevision') : t('aLoreOperationIsInProgress')}</small>
          )}
        </span>
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={busy}
        title={
          busy
            ? t('waitCurrentLoreOperationFinish_410e')
            : t('status.createBranchFromRevision', { revision: revision.shortId })
        }
        onClick={() =>
          closeThen(() =>
            onCreateBranch({
              kind: 'revision',
              branch: sourceBranch,
              revision: revision.id
            })
          )
        }
      >
        <Plus size={15} />
        <span>
          {t('newBranch_2')}
          {busy && <small>{t('aLoreOperationIsInProgress')}</small>}
        </span>
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={busy}
        title={
          busy
            ? t('waitCurrentLoreOperationFinish_410e')
            : t('status.createSharedTagAt', { source: sourceBranch, revision: revision.shortId })
        }
        onClick={() =>
          closeThen(() =>
            onCreateTag({
              kind: 'revision',
              branch: sourceBranch,
              revision: revision.id
            })
          )
        }
      >
        <Tags size={15} />
        <span>
          {t('newTag_2')}
          {busy && <small>{t('aLoreOperationIsInProgress')}</small>}
        </span>
      </button>
      <hr />
      <button
        type="button"
        role="menuitem"
        disabled={busy || isCurrentRevision}
        title={
          isCurrentRevision
            ? t('revisionAlreadyWorkspaceBaseline_ff7e')
            : busy
              ? t('waitCurrentLoreOperationFinish_410e')
              : t('status.applyRevisionToBranch', { branch: currentBranch })
        }
        onClick={() => closeThen(() => onCherryPickRevision(revision))}
      >
        <GitCommitHorizontal size={15} />
        <span>
          {t('status.cherryPickOnto', { branch: currentBranch })}
          {(busy || isCurrentRevision) && (
            <small>{isCurrentRevision ? t('alreadyTheCurrentRevision') : t('aLoreOperationIsInProgress')}</small>
          )}
        </span>
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={busy}
        title={busy ? t('waitCurrentLoreOperationFinish_410e') : t('createNewRevisionRevertsRevision_3a2c')}
        onClick={() => closeThen(() => onRevertRevision(revision))}
      >
        <RotateCcw size={15} />
        <span>
          {t('revert')}
          {busy && <small>{t('aLoreOperationIsInProgress')}</small>}
        </span>
      </button>
      <hr />
      <button
        type="button"
        role="menuitem"
        onClick={() => closeThen(() => void copyText(revision.id, t('revisionId')))}
      >
        <Copy size={15} />
        <span>{t('copyId')}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => closeThen(() => void copyText(getRevisionClipboardInfo(revision), t('revisionInformation')))}
      >
        <ClipboardCopy size={15} />
        <span>{t('copyInformation')}</span>
      </button>
    </>
  )
}

interface BranchMenuItemsProps {
  branch: Branch
  currentBranch: string
  busy: boolean
  closeThen: (action: () => void) => void
  copyText: (value: string, label: string) => Promise<void>
  onSwitchBranch: (branch: Branch) => void
  onPushBranch: (branch: Branch) => void
  onMergeBranch: (branch: Branch) => void
  onArchiveBranch: (branch: Branch) => void
  onCreateBranch: (source: BranchCreationSource) => void
  onCreateTag: (source: TagCreationSource) => void
}

interface ArchivedBranchMenuItemsProps {
  branch: Branch
  busy: boolean
  closeThen: (action: () => void) => void
  copyText: (value: string, label: string) => Promise<void>
  onOpenBranchRevision: (branch: Branch) => void
  onCreateTag: (source: TagCreationSource) => void
}

/**
 * 已归档分支只展示不会把它冒充为活动指针的操作。
 *
 * Lore 0.8.6 的 archive 会删除名称到 Branch ID 的映射，公共 API 没有 unarchive；
 * 因此这里允许定位、打标签和复制信息，并把“恢复”保留为带原因的禁用项。
 */
export function ArchivedBranchMenuItems({
  branch,
  busy,
  closeThen,
  copyText,
  onOpenBranchRevision,
  onCreateTag
}: ArchivedBranchMenuItemsProps) {
  return (
    <>
      <button
        type="button"
        role="menuitem"
        disabled={!branch.latest}
        title={
          branch.latest ? t('locateArchivedBranchRevisionCurrently_95da') : t('archivedBranchAvailableRevision_4860')
        }
        onClick={() => closeThen(() => onOpenBranchRevision(branch))}
      >
        <History size={15} />
        <span>
          {t('locateRevisionInHistory')}
          {!branch.latest && <small>{t('archivedBranchAvailableRevision_4860')}</small>}
        </span>
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={busy || !branch.latest}
        title={
          !branch.latest
            ? t('archivedBranchAvailableRevision_4860')
            : busy
              ? t('waitCurrentLoreOperationFinish_410e')
              : t('createRepositorySharedTagArchived_7389')
        }
        onClick={() => {
          if (!branch.latest) return
          closeThen(() =>
            onCreateTag({
              kind: 'branch',
              branch: branch.name,
              revision: branch.latest ?? ''
            })
          )
        }}
      >
        <Tags size={15} />
        <span>
          {t('createTagOnRevision')}
          {(busy || !branch.latest) && (
            <small>{busy ? t('aLoreOperationIsInProgress') : t('noRevisionsAvailable')}</small>
          )}
        </span>
      </button>
      <hr />
      <button
        type="button"
        role="menuitem"
        onClick={() => closeThen(() => void copyText(branch.name, t('branchName')))}
      >
        <GitBranch size={15} />
        <span>{t('copyBranchName')}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={!branch.latest}
        onClick={() => {
          if (branch.latest) closeThen(() => void copyText(branch.latest ?? '', t('revisionId')))
        }}
      >
        <Copy size={15} />
        <span>
          {t('copyLatestRevisionId')}
          {!branch.latest && <small>{t('noRevisionsAvailable')}</small>}
        </span>
      </button>
    </>
  )
}

function BranchMenuItems({
  branch,
  currentBranch,
  busy,
  closeThen,
  copyText,
  onSwitchBranch,
  onPushBranch,
  onMergeBranch,
  onArchiveBranch,
  onCreateBranch,
  onCreateTag
}: BranchMenuItemsProps) {
  const isCurrent = branch.current || branch.name === currentBranch
  const blockedReason = busy ? t('aLoreOperationIsInProgress') : undefined
  return (
    <>
      <button
        type="button"
        role="menuitem"
        disabled={busy || isCurrent}
        title={
          isCurrent
            ? t('workspaceAlreadyAttachedBranch_5924')
            : busy
              ? t('waitCurrentLoreOperationFinish_410e')
              : branch.remote
                ? t('createAttachLocalWorkingBranch_20f9')
                : t('switchCurrentWorkspace')
        }
        onClick={() => closeThen(() => onSwitchBranch(branch))}
      >
        {branch.remote ? <Radio size={15} /> : <LogIn size={15} />}
        <span>
          {branch.remote ? t('switchAndAttachRemoteBranch') : t('switchToThisBranch')}
          {(isCurrent || blockedReason) && <small>{isCurrent ? t('alreadyTheCurrentBranch') : blockedReason}</small>}
        </span>
        {isCurrent && <CheckCircle2 size={14} />}
      </button>

      <button
        type="button"
        role="menuitem"
        disabled={busy || !branch.latest}
        title={
          !branch.latest
            ? t('branchAvailableSourceRevision_8d04')
            : busy
              ? t('waitCurrentLoreOperationFinish_410e')
              : t('status.createBranchFromBranchLatest', { branch: branch.name })
        }
        onClick={() => {
          const sourceRevision = branch.latest
          if (!sourceRevision) return
          closeThen(() =>
            onCreateBranch({
              kind: 'branch',
              branch: branch.name,
              revision: sourceRevision,
              remote: branch.remote
            })
          )
        }}
      >
        <Plus size={15} />
        <span>
          {t('newBranch_2')}
          {(busy || !branch.latest) && (
            <small>{!branch.latest ? t('thisBranchHasNoRevisions') : t('aLoreOperationIsInProgress')}</small>
          )}
        </span>
      </button>

      <button
        type="button"
        role="menuitem"
        disabled={busy || !branch.latest}
        title={
          !branch.latest
            ? t('branchAvailableSourceRevision_8d04')
            : busy
              ? t('waitCurrentLoreOperationFinish_410e')
              : t('status.createSharedTagOnBranchLatest', { branch: branch.name })
        }
        onClick={() => {
          const sourceRevision = branch.latest
          if (!sourceRevision) return
          closeThen(() =>
            onCreateTag({
              kind: 'branch',
              branch: branch.name,
              revision: sourceRevision
            })
          )
        }}
      >
        <Tags size={15} />
        <span>
          {t('newTag_2')}
          {(busy || !branch.latest) && (
            <small>{!branch.latest ? t('thisBranchHasNoRevisions') : t('aLoreOperationIsInProgress')}</small>
          )}
        </span>
      </button>

      {!branch.remote && (
        <button
          type="button"
          role="menuitem"
          disabled={busy}
          title={busy ? t('waitCurrentLoreOperationFinish_410e') : t('pushBranchLoreRemote_1af7')}
          onClick={() => closeThen(() => onPushBranch(branch))}
        >
          <Send size={15} />
          <span>
            {t('status.pushBranch', { branch: branch.name })}
            {blockedReason && <small>{blockedReason}</small>}
          </span>
        </button>
      )}

      <button
        type="button"
        role="menuitem"
        disabled={busy || isCurrent}
        title={
          isCurrent
            ? t('currentBranchMergedItself_3635')
            : busy
              ? t('waitCurrentLoreOperationFinish_410e')
              : t('status.mergeBranchInto', { source: branch.name, target: currentBranch })
        }
        onClick={() => closeThen(() => onMergeBranch(branch))}
      >
        <GitMerge size={15} />
        <span>
          {t('status.mergeIntoEllipsis', { branch: currentBranch })}
          {(isCurrent || blockedReason) && (
            <small>{isCurrent ? t('currentBranchMergedItself_3635') : blockedReason}</small>
          )}
        </span>
      </button>

      {!branch.remote && (
        <>
          <hr />
          <button
            type="button"
            role="menuitem"
            className="is-danger"
            disabled={busy || isCurrent}
            title={
              isCurrent
                ? t('loreAllowArchivingCurrentBranch_a32a')
                : busy
                  ? t('waitCurrentLoreOperationFinish_410e')
                  : t('archiveLocalPointerSynchronizeRemote_6cb3')
            }
            onClick={() => closeThen(() => onArchiveBranch(branch))}
          >
            <Archive size={15} />
            <span>
              {t('archiveBranch_2')}
              {(isCurrent || blockedReason) && (
                <small>{isCurrent ? t('theCurrentBranchCannotBeArchived') : blockedReason}</small>
              )}
            </span>
          </button>
        </>
      )}

      <hr />
      <button
        type="button"
        role="menuitem"
        onClick={() => closeThen(() => void copyText(branch.name, t('branchName')))}
      >
        <GitBranch size={15} />
        <span>{t('copyBranchName')}</span>
      </button>
    </>
  )
}
