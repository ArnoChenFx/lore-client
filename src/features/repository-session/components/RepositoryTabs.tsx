import { Plus, X } from 'lucide-react'
import { useState, type CSSProperties, type DragEvent, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { t } from '../../../i18n'
import type { Repository } from '../../../types'

/** 一个本地工作区 Tab；`sessionKey` 与可相同的 Lore Repository ID 明确分离。 */
export interface RepositoryTab {
  sessionKey: string
  repository: Repository
}

interface RepositoryTabsProps {
  tabs: RepositoryTab[]
  activeId: string
  onSelect: (repositoryId: string) => void
  onClose: (repositoryId: string) => void
  onReorder: (sourceRepositoryId: string, targetRepositoryId: string) => void
  onAdd: () => void
}

const REPOSITORY_TAB_DRAG_TYPE = 'application/x-lore-repository-tab'

export function RepositoryTabs({ tabs, activeId, onSelect, onClose, onReorder, onAdd }: RepositoryTabsProps) {
  const { t } = useTranslation()
  const [draggingRepositoryId, setDraggingRepositoryId] = useState<string | null>(null)
  const [dropTargetRepositoryId, setDropTargetRepositoryId] = useState<string | null>(null)
  const draggingIndex = tabs.findIndex((tab) => tab.sessionKey === draggingRepositoryId)

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

  return (
    <nav className="repository-tabs" aria-label={t('openRepositories')}>
      {tabs.map(({ sessionKey, repository }, index) => {
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
            <button
              type="button"
              className="repository-tab__select"
              draggable={tabs.length > 1}
              aria-current={sessionKey === activeId ? 'page' : undefined}
              aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
              aria-label={t('status.openRepositoryReorder', { name: repository.name })}
              title={t('status.tabReorderHint', { name: repository.path })}
              onClick={() => onSelect(sessionKey)}
              onKeyDown={(event) => handleReorderKeyDown(event, sessionKey, index)}
              onDragStart={(event) => handleDragStart(event, sessionKey)}
              onDragEnd={clearDragState}
            >
              <i style={{ '--repo-color': repository.color } as CSSProperties} />
              <span>{repository.name}</span>
              {(repository.ahead > 0 || repository.behind > 0) && (
                <small>
                  {repository.ahead > 0 && `↑${repository.ahead}`}
                  {repository.behind > 0 && ` ↓${repository.behind}`}
                </small>
              )}
            </button>
            {sessionKey === activeId && (
              <button
                type="button"
                className="repository-tab__close"
                aria-label={t('status.closeRepository', { name: repository.name })}
                title={t('status.closeRepository', { name: repository.name })}
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
  )
}
