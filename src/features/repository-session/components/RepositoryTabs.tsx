import { Plus, X } from 'lucide-react'
import { useState, type CSSProperties, type DragEvent, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { t } from '../../../i18n'
import type { Repository } from '../../../types'

interface RepositoryTabsProps {
  repositories: Repository[]
  activeId: string
  onSelect: (repositoryId: string) => void
  onClose: (repositoryId: string) => void
  onReorder: (sourceRepositoryId: string, targetRepositoryId: string) => void
  onAdd: () => void
}

const REPOSITORY_TAB_DRAG_TYPE = 'application/x-lore-repository-tab'

export function RepositoryTabs({ repositories, activeId, onSelect, onClose, onReorder, onAdd }: RepositoryTabsProps) {
  const { t } = useTranslation()
  const [draggingRepositoryId, setDraggingRepositoryId] = useState<string | null>(null)
  const [dropTargetRepositoryId, setDropTargetRepositoryId] = useState<string | null>(null)
  const draggingIndex = repositories.findIndex((repository) => repository.id === draggingRepositoryId)

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
    const targetRepository = repositories[index + offset]
    if (!targetRepository) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    onReorder(repositoryId, targetRepository.id)
  }

  return (
    <nav className="repository-tabs" aria-label={t('openRepositories')}>
      {repositories.map((repository, index) => {
        const isDragging = repository.id === draggingRepositoryId
        const isDropTarget = repository.id === dropTargetRepositoryId && !isDragging
        const dropTargetSide = isDropTarget && draggingIndex < index ? 'after' : 'before'

        return (
          <div
            key={repository.id}
            className={[
              'repository-tab',
              repository.id === activeId ? 'is-active' : '',
              isDragging ? 'is-dragging' : '',
              isDropTarget ? `is-drop-target-${dropTargetSide}` : ''
            ]
              .filter(Boolean)
              .join(' ')}
            onDragEnter={(event) => {
              if (!draggingRepositoryId || isDragging) return
              event.preventDefault()
              setDropTargetRepositoryId(repository.id)
            }}
            onDragOver={(event) => {
              if (!draggingRepositoryId || isDragging) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
            }}
            onDrop={(event) => handleDrop(event, repository.id)}
          >
            <button
              type="button"
              className="repository-tab__select"
              draggable={repositories.length > 1}
              aria-current={repository.id === activeId ? 'page' : undefined}
              aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
              aria-label={t('status.openRepositoryReorder', { name: repository.name })}
              title={t('status.tabReorderHint', { name: repository.path })}
              onClick={() => onSelect(repository.id)}
              onKeyDown={(event) => handleReorderKeyDown(event, repository.id, index)}
              onDragStart={(event) => handleDragStart(event, repository.id)}
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
            {repository.id === activeId && (
              <button
                type="button"
                className="repository-tab__close"
                aria-label={t('status.closeRepository', { name: repository.name })}
                title={t('status.closeRepository', { name: repository.name })}
                onClick={() => onClose(repository.id)}
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
      <span className="repository-tabs__cache">{t('status.repositoriesOpen', { count: repositories.length })}</span>
    </nav>
  )
}
