import { Clock3, GitBranch, GitCommitHorizontal, MessageSquareText, Pencil, Tags, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { t } from '../../../i18n'
import type { LoreTag } from '../../../types'

interface TagDetailsDialogProps {
  tag: LoreTag
  onEdit: (tag: LoreTag) => void
  onLocateRevision: (tag: LoreTag) => void
  onClose: () => void
}

/** 只读展示标签的稳定目标与共享状态，避免在列表中塞入过多次要字段。 */
export function TagDetailsDialog({ tag, onEdit, onLocateRevision, onClose }: TagDetailsDialogProps) {
  const { t } = useTranslation()
  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section className="task-dialog tag-details-dialog" role="dialog">
        <header className="task-dialog__header">
          <span className="task-dialog__mark">
            <Tags size={18} />
          </span>
          <span>
            <small>{t('tagDetails')}</small>
            <h2>{tag.name}</h2>
          </span>
          <button type="button" aria-label={t('close')} onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <div className="task-dialog__body">
          <div className="tag-details-grid">
            <article>
              <GitBranch size={15} />
              <span>
                <small>{t('sourceBranch')}</small>
                <strong>{tag.branch}</strong>
              </span>
            </article>
            <article>
              <GitCommitHorizontal size={15} />
              <span>
                <small>{t('targetRevision')}</small>
                <code>{tag.revision}</code>
              </span>
            </article>
            <article>
              <Clock3 size={15} />
              <span>
                <small>{t('created')}</small>
                <strong>{formatFullTime(tag.createdAt)}</strong>
              </span>
            </article>
            <article>
              <Clock3 size={15} />
              <span>
                <small>{t('lastModified')}</small>
                <strong>{formatFullTime(tag.updatedAt)}</strong>
              </span>
            </article>
          </div>

          <section className="tag-details-message">
            <header>
              <MessageSquareText size={14} />
              <strong>{t('description')}</strong>
            </header>
            <p>{tag.message || t('thisTagHasNoDescription')}</p>
          </section>

          <p className="tag-details-id">
            <span>{t('stableId')}</span>
            <code>{tag.id}</code>
          </p>
        </div>

        <footer className="task-dialog__footer">
          <button
            type="button"
            onClick={() => {
              onClose()
              onLocateRevision(tag)
            }}
          >
            <GitCommitHorizontal size={14} />
            {t('locateRevision')}
          </button>
          <button
            className="is-primary"
            type="button"
            onClick={() => {
              onClose()
              onEdit(tag)
            }}
          >
            <Pencil size={14} />
            {t('editTag')}
          </button>
        </footer>
      </section>
    </div>
  )
}

function formatFullTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date(timestamp))
}
