import { ClipboardCopy, Copy, GitCommitHorizontal, Info, Pencil, Tags, Trash2 } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { t } from '../../../i18n'
import type { ContextMenuPoint } from '../../../shared/ui'
import type { LoreTag, ToastMessage } from '../../../types'

export type TagMenuRequest = { tag: LoreTag } & ContextMenuPoint

interface TagContextMenuProps {
  request: TagMenuRequest
  busy: boolean
  onClose: () => void
  onDetails: (tag: LoreTag) => void
  onLocateRevision: (tag: LoreTag) => void
  onEdit: (tag: LoreTag) => void
  onDelete: (tag: LoreTag) => void
  onNotify: (title: string, detail: string, tone?: ToastMessage['tone']) => void
}

const VIEWPORT_GAP = 8

/** 标签专用上下文菜单，坐标、键盘和焦点恢复行为与 Revision 菜单一致。 */
export function TagContextMenu({
  request,
  busy,
  onClose,
  onDetails,
  onLocateRevision,
  onEdit,
  onDelete,
  onNotify
}: TagContextMenuProps) {
  const { t } = useTranslation()
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
    const frame = requestAnimationFrame(() =>
      menuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus()
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
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault()
      onClose()
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

  const { tag } = request
  return createPortal(
    <div
      ref={menuRef}
      className="revision-file-menu version-context-menu tag-context-menu"
      role="menu"
      aria-label={t('status.contextActionsFor', { title: tag.name })}
      onKeyDown={handleKeyDown}
      style={{
        left: position.left,
        top: position.top,
        visibility: position.ready ? 'visible' : 'hidden'
      }}
    >
      <header>
        <strong title={tag.name}>{tag.name}</strong>
        <small>{t('status.tagSubtitle', { branch: tag.branch, revision: tag.revision.slice(0, 8) })}</small>
      </header>
      <button type="button" role="menuitem" onClick={() => closeThen(() => onDetails(tag))}>
        <Info size={15} />
        <span>{t('viewTagDetails')}</span>
      </button>
      <button type="button" role="menuitem" onClick={() => closeThen(() => onLocateRevision(tag))}>
        <GitCommitHorizontal size={15} />
        <span>{t('locateRevision')}</span>
      </button>
      <button type="button" role="menuitem" disabled={busy} onClick={() => closeThen(() => onEdit(tag))}>
        <Pencil size={15} />
        <span>
          {t('editTag_2')}
          {busy && <small>{t('aLoreOperationIsInProgress')}</small>}
        </span>
      </button>
      <hr />
      <button
        type="button"
        role="menuitem"
        className="is-danger"
        disabled={busy}
        onClick={() => closeThen(() => onDelete(tag))}
      >
        <Trash2 size={15} />
        <span>
          {t('deleteTag_2')}
          {busy && <small>{t('aLoreOperationIsInProgress')}</small>}
        </span>
      </button>
      <hr />
      <button type="button" role="menuitem" onClick={() => closeThen(() => void copyText(tag.name, t('tagName')))}>
        <Tags size={15} />
        <span>{t('copyTagName')}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => closeThen(() => void copyText(tag.revision, t('revisionId')))}
      >
        <Copy size={15} />
        <span>{t('copyRevisionId')}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() =>
          closeThen(
            () =>
              void copyText(
                t('status.tagClipboardInfo', {
                  name: tag.name,
                  branch: tag.branch,
                  revision: tag.revision,
                  message: tag.message || t('none')
                }),
                t('tagInformation')
              )
          )
        }
      >
        <ClipboardCopy size={15} />
        <span>{t('copyTagInformation')}</span>
      </button>
    </div>,
    document.body
  )
}
