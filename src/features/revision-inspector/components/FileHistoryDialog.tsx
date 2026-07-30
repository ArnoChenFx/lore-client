import { ArrowRight, Clock3, FileClock, File, LoaderCircle, TriangleAlert, X } from 'lucide-react'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { t } from '../../../i18n'
import { changeFilePath } from '../../../shared/lib'
import type { FileHistoryEntry, RepositoryFileReference, Revision } from '../../../types'

interface FileHistoryDialogProps {
  file: RepositoryFileReference
  mode: 'timeline' | 'history'
  entries: FileHistoryEntry[]
  revisions: Revision[]
  loading: boolean
  error: string | null
  onSelectRevision: (revision: Revision) => void
  onClose: () => void
}

const actionLabels: Record<string, string> = {
  add: t('added'),
  delete: t('delete'),
  move: t('moved'),
  copy: t('copy'),
  keep: t('modified')
}

/** 文件时间线与历史列表共享 Lore `file::history` 数据，只改变标题语义。 */
export function FileHistoryDialog({
  file,
  mode,
  entries,
  revisions,
  loading,
  error,
  onSelectRevision,
  onClose
}: FileHistoryDialogProps) {
  const { t } = useTranslation()
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return createPortal(
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="task-dialog file-history-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('status.fileHistoryOf', { name: file.name })}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="task-dialog__header">
          <span className="task-dialog__mark">
            {mode === 'timeline' ? <Clock3 size={17} /> : <FileClock size={17} />}
          </span>
          <span>
            <small>LORE FILE HISTORY</small>
            <h2>{mode === 'timeline' ? t('fileTimeline') : t('fileHistory')}</h2>
          </span>
          <button type="button" onClick={onClose} aria-label={t('closeFileHistory')}>
            <X size={16} />
          </button>
        </header>
        <div className="task-dialog__body">
          <div className="file-history-dialog__path">
            <File size={15} />
            <span>
              <strong>{file.name}</strong>
              <small>{changeFilePath(file)}</small>
            </span>
            <em>{t('status.historyRecordCount', { count: entries.length })}</em>
          </div>

          {loading ? (
            <div className="file-history-dialog__empty">
              <LoaderCircle className="is-spinning" size={25} />
              <strong>{t('loadingLoreFileHistory')}</strong>
            </div>
          ) : error ? (
            <div className="file-history-dialog__empty is-error">
              <TriangleAlert size={25} />
              <strong>{t('unableToLoadFileHistory')}</strong>
              <span>{error}</span>
            </div>
          ) : entries.length === 0 ? (
            <div className="file-history-dialog__empty">
              <FileClock size={25} />
              <strong>{t('noFileHistoryFound')}</strong>
              <span>{t('revisionContainingPathWasFound_5baf')}</span>
            </div>
          ) : (
            <div className="file-history-list">
              {entries.map((entry) => {
                const revision = revisions.find((candidate) => candidate.id === entry.revision)
                return (
                  <button
                    key={`${entry.revision}:${entry.path}`}
                    type="button"
                    className="file-history-row"
                    disabled={!revision}
                    onClick={() => {
                      if (revision) onSelectRevision(revision)
                    }}
                  >
                    <span className="file-history-row__rail">
                      <i />
                    </span>
                    <span>
                      <strong>{revision?.title ?? `Revision #${entry.revisionNumber}`}</strong>
                      <small>
                        {revision?.author ?? t('authorInformationUnavailable')} ·{' '}
                        {revision?.relativeTime ?? entry.revision.slice(0, 8)}
                      </small>
                    </span>
                    <code>{entry.revision.slice(0, 8)}</code>
                    <em>{actionLabels[entry.action] ?? entry.action}</em>
                    {revision && <ArrowRight size={14} />}
                  </button>
                )
              })}
            </div>
          )}
        </div>
        <footer className="task-dialog__footer">
          <span>{t('doubleClickWorkspaceFileView_7e51')}</span>
          <button type="button" onClick={onClose}>
            {t('close')}
          </button>
        </footer>
      </section>
    </div>,
    document.body
  )
}
