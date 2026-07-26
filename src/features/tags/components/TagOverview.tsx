import { Plus, Search, Tags } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { t } from '../../../i18n'
import type { ContextMenuPoint } from '../../../shared/ui'
import type { LoreTag } from '../../../types'

interface TagOverviewProps {
  tags: LoreTag[]
  selectedTagId: string
  onSelect: (tag: LoreTag) => void
  onLocateRevision: (tag: LoreTag) => void
  onContextMenu: (tag: LoreTag, point: ContextMenuPoint) => void
  onCreate: () => void
}

/** 仓库级标签列表；单击只选择，双击才定位到对应 Revision。 */
export function TagOverview({
  tags,
  selectedTagId,
  onSelect,
  onLocateRevision,
  onContextMenu,
  onCreate
}: TagOverviewProps) {
  const { t } = useTranslation()
  const [filter, setFilter] = useState('')
  const visibleTags = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase()
    if (!query) return tags
    return tags.filter((tag) =>
      [tag.name, tag.branch, tag.revision, tag.message].some((value) => value.toLocaleLowerCase().includes(query))
    )
  }, [filter, tags])

  return (
    <section className="tag-overview">
      <header className="tag-overview__header">
        <div>
          <span className="panel-header__eyebrow">{t('repositorySharedPointer')}</span>
          <strong>{t('tagList')}</strong>
          <small>{t('status.tagCount', { count: tags.length })}</small>
        </div>
        <div className="tag-overview__actions">
          <label className="tag-overview__filter composite-input">
            <Search size={13} aria-hidden="true" />
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={t('filterTagsBranchesOrRevisions')}
              aria-label={t('filterTags')}
            />
          </label>
          <button type="button" onClick={onCreate}>
            <Plus size={14} />
            {t('newTag')}
          </button>
        </div>
      </header>

      <div className="tag-table" role="list" aria-label={t('tagList')}>
        <div className="tag-table__columns" aria-hidden="true">
          <span>{t('tags')}</span>
          <span>{t('target')}</span>
          <span>{t('description')}</span>
          <span>{t('updated')}</span>
        </div>
        {visibleTags.map((tag) => (
          <button
            key={tag.id}
            type="button"
            role="listitem"
            className={`tag-row ${tag.id === selectedTagId ? 'is-selected' : ''}`}
            onClick={() => onSelect(tag)}
            onDoubleClick={() => onLocateRevision(tag)}
            onContextMenu={(event) => {
              event.preventDefault()
              onContextMenu(tag, {
                x: event.clientX,
                y: event.clientY,
                anchor: event.currentTarget
              })
            }}
            title={`${tag.name} · ${t('status.selectLocateRevisionHint')}`}
          >
            <span className="tag-row__identity">
              <span>
                <strong>{tag.name}</strong>
                <small>{t('repositorySharedMetadata')}</small>
              </span>
            </span>
            <span className="tag-row__target">
              <span>{tag.branch}</span>
              <code>{tag.revision.slice(0, 8)}</code>
            </span>
            <span className="tag-row__message">
              <span>{tag.message || t('noTagDescription')}</span>
            </span>
            <time dateTime={new Date(tag.updatedAt).toISOString()}>{formatTagTime(tag.updatedAt)}</time>
          </button>
        ))}
      </div>

      {visibleTags.length === 0 && (
        <div className="empty-state tag-overview__empty">
          <Tags size={24} />
          <strong>{tags.length ? t('noMatchingTags') : t('thisRepositoryHasNoTags')}</strong>
          <span>{tags.length ? t('adjustFiltersToShowOtherTags') : t('createCurrentWorkspaceBranchAny_352e')}</span>
          {!tags.length && (
            <button type="button" onClick={onCreate}>
              <Plus size={13} />
              {t('createTheFirstTag')}
            </button>
          )}
        </div>
      )}
    </section>
  )
}

function formatTagTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(timestamp))
}
