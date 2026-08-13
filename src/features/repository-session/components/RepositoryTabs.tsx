import { Plus, X } from 'lucide-react'
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { useTranslation } from 'react-i18next'

import type { RepositoryAccentColor } from '../../../shared/lib'
import { TextInput } from '../../../shared/ui'
import { RepositoryTabContextMenu, type RepositoryTabMenuRequest } from './RepositoryTabContextMenu'
import type { RepositoryTab } from './repositoryTabsModel'

export type { RepositoryTab } from './repositoryTabsModel'

interface RepositoryTabsProps {
  tabs: RepositoryTab[]
  activeId: string
  onSelect: (repositoryId: string) => void
  onClose: (repositoryId: string) => void
  onCloseOthers: (repositoryId: string) => void
  onCloseAll: () => void
  onReorder: (sourceRepositoryId: string, targetRepositoryId: string) => void
  onRename: (repositoryPath: string, name: string) => void
  onRestoreName: (repositoryPath: string) => void
  onColorChange: (repositoryPath: string, color: RepositoryAccentColor | null) => void
  onAdd: () => void
}

const REPOSITORY_TAB_DRAG_TYPE = 'application/x-lore-repository-tab'

export function RepositoryTabs({
  tabs,
  activeId,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseAll,
  onReorder,
  onRename,
  onRestoreName,
  onColorChange,
  onAdd
}: RepositoryTabsProps) {
  const { t } = useTranslation()
  const [draggingRepositoryId, setDraggingRepositoryId] = useState<string | null>(null)
  const [dropTargetRepositoryId, setDropTargetRepositoryId] = useState<string | null>(null)
  const [menuRequest, setMenuRequest] = useState<RepositoryTabMenuRequest | null>(null)
  const [editingSessionKey, setEditingSessionKey] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const draggingIndex = tabs.findIndex((tab) => tab.sessionKey === draggingRepositoryId)

  useEffect(() => {
    if (!editingSessionKey) return
    const frame = requestAnimationFrame(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [editingSessionKey])

  // 正在编辑的标签被移除（关闭或拖拽重排后消失）时退出编辑态；置空后条件自然失效。
  if (editingSessionKey && !tabs.some((tab) => tab.sessionKey === editingSessionKey)) {
    setEditingSessionKey(null)
  }

  /**
   * 拖放结束、取消或离开浏览器拖放会话时统一清理视觉状态。这里不修改仓库
   * 选中态，确保“重新排序”和“切换项目”始终是两个独立动作。
   */
  const clearDragState = () => {
    setDraggingRepositoryId(null)
    setDropTargetRepositoryId(null)
  }

  const handleDragStart = (event: DragEvent<HTMLButtonElement>, repositoryId: string) => {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(REPOSITORY_TAB_DRAG_TYPE, repositoryId)
    // `text/plain` 作为 WebView2 与浏览器实现之间的兼容回退，不承载外部路径。
    event.dataTransfer.setData('text/plain', repositoryId)
    setDraggingRepositoryId(repositoryId)
    setDropTargetRepositoryId(null)
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>, targetRepositoryId: string) => {
    event.preventDefault()
    const sourceRepositoryId =
      event.dataTransfer.getData(REPOSITORY_TAB_DRAG_TYPE) ||
      event.dataTransfer.getData('text/plain') ||
      draggingRepositoryId
    clearDragState()
    if (!sourceRepositoryId || sourceRepositoryId === targetRepositoryId) {
      return
    }
    onReorder(sourceRepositoryId, targetRepositoryId)
  }

  const handleReorderKeyDown = (event: KeyboardEvent<HTMLButtonElement>, repositoryId: string, index: number) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return
    }

    const offset = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    if (offset === 0) {
      return
    }
    const targetTab = tabs[index + offset]
    if (!targetTab) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    onReorder(repositoryId, targetTab.sessionKey)
  }

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, tab: RepositoryTab, index: number) => {
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault()
      event.stopPropagation()
      const bounds = event.currentTarget.getBoundingClientRect()
      setMenuRequest({
        tab,
        x: Math.min(bounds.left + 18, bounds.right),
        y: Math.min(bounds.bottom, window.innerHeight - 8),
        anchor: event.currentTarget
      })
      return
    }
    handleReorderKeyDown(event, tab.sessionKey, index)
  }

  const openContextMenu = (event: ReactMouseEvent<HTMLDivElement>, tab: RepositoryTab) => {
    event.preventDefault()
    event.stopPropagation()
    const anchor = event.currentTarget.querySelector<HTMLElement>('.repository-tab__select') ?? event.currentTarget
    setMenuRequest({ tab, x: event.clientX, y: event.clientY, anchor })
  }

  const beginRename = (sessionKey: string) => {
    const tab = tabs.find((candidate) => candidate.sessionKey === sessionKey)
    if (!tab) return
    setRenameDraft(tab.displayName)
    setEditingSessionKey(sessionKey)
  }

  const finishRename = () => {
    const tab = tabs.find((candidate) => candidate.sessionKey === editingSessionKey)
    const name = renameDraft.trim()
    setEditingSessionKey(null)
    if (tab && name && name !== tab.displayName) onRename(tab.repository.path, name)
  }

  return (
    <>
      <nav className="repository-tabs" aria-label={t('openRepositories')}>
        {tabs.map((tab, index) => {
          const { sessionKey, repository, displayName, displayColor } = tab
          const isDragging = sessionKey === draggingRepositoryId
          const isDropTarget = sessionKey === dropTargetRepositoryId && !isDragging
          const dropTargetSide = isDropTarget && draggingIndex < index ? 'after' : 'before'

          return (
            <div
              key={sessionKey}
              className={[
                'repository-tab',
                sessionKey === activeId ? 'is-active' : '',
                isDragging ? 'is-dragging' : '',
                isDropTarget ? `is-drop-target-${dropTargetSide}` : ''
              ]
                .filter(Boolean)
                .join(' ')}
              onContextMenu={(event) => openContextMenu(event, tab)}
              onDragEnter={(event) => {
                if (!draggingRepositoryId || isDragging) return
                event.preventDefault()
                setDropTargetRepositoryId(sessionKey)
              }}
              onDragOver={(event) => {
                if (!draggingRepositoryId || isDragging) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
              }}
              onDrop={(event) => handleDrop(event, sessionKey)}
            >
              {editingSessionKey === sessionKey ? (
                <TextInput
                  ref={renameInputRef}
                  className="repository-tab__rename"
                  value={renameDraft}
                  maxLength={80}
                  aria-label={t('status.renameRepositoryTabInput', { name: displayName })}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onBlur={finishRename}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      finishRename()
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      setEditingSessionKey(null)
                    }
                  }}
                  onClick={(event) => event.stopPropagation()}
                />
              ) : (
                <button
                  type="button"
                  className="repository-tab__select"
                  draggable={tabs.length > 1}
                  aria-current={sessionKey === activeId ? 'page' : undefined}
                  aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Shift+F10"
                  aria-label={t('status.openRepositoryReorder', { name: displayName })}
                  title={t('status.tabReorderHint', { name: repository.path })}
                  onClick={() => onSelect(sessionKey)}
                  onKeyDown={(event) => handleTabKeyDown(event, tab, index)}
                  onDragStart={(event) => handleDragStart(event, sessionKey)}
                  onDragEnd={clearDragState}
                >
                  <i style={{ '--repo-color': displayColor } as CSSProperties} />
                  <span>{displayName}</span>
                  {(repository.ahead > 0 || repository.behind > 0) && (
                    <small>
                      {repository.ahead > 0 && `↑${repository.ahead}`}
                      {repository.behind > 0 && ` ↓${repository.behind}`}
                    </small>
                  )}
                </button>
              )}
              {sessionKey === activeId && (
                <button
                  type="button"
                  className="repository-tab__close"
                  aria-label={t('status.closeRepository', { name: displayName })}
                  title={t('status.closeRepository', { name: displayName })}
                  onClick={() => onClose(sessionKey)}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          )
        })}
        <button
          type="button"
          className="repository-tabs__add"
          aria-label={t('openAnotherRepository')}
          title={t('openAnotherRepository')}
          onClick={onAdd}
        >
          <Plus size={15} />
        </button>
        <span className="repository-tabs__spacer" />
        <span className="repository-tabs__cache">{t('status.repositoriesOpen', { count: tabs.length })}</span>
      </nav>
      {menuRequest && (
        <RepositoryTabContextMenu
          request={menuRequest}
          tabCount={tabs.length}
          onClose={() => setMenuRequest(null)}
          onCloseTab={onClose}
          onCloseOthers={onCloseOthers}
          onCloseAll={onCloseAll}
          onRename={beginRename}
          onRestoreName={onRestoreName}
          onColorChange={onColorChange}
        />
      )}
    </>
  )
}
