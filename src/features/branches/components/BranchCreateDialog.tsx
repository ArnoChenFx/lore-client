import { GitBranch, GitCommitHorizontal, LoaderCircle, Plus, Radio, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { t } from '../../../i18n'
import type { BranchCreationSource } from '../../../types'

interface BranchCreateDialogProps {
  busy: boolean
  source: BranchCreationSource
  onCreate: (name: string) => void
  onClose: () => void
}

/** Branch 命名入口；后端仍会执行最终的安全校验。 */
export function BranchCreateDialog({ busy, source, onCreate, onClose }: BranchCreateDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const sourceDescription =
    source.kind === 'revision'
      ? t('createFromTheSelectedRevision')
      : source.remote
        ? t('createFromTheRemoteBranchRevision')
        : source.kind === 'branch'
          ? t('createFromTheSelectedBranchRevision')
          : t('createFromTheCurrentWorkspaceRevision')
  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <form
        className="task-dialog compact-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (name.trim()) onCreate(name.trim())
        }}
      >
        <header className="task-dialog__header">
          <span className="task-dialog__mark">
            <GitBranch size={18} />
          </span>
          <span>
            <small>{t('pointer')}</small>
            <h2>{t('newBranch')}</h2>
          </span>
          <button type="button" aria-label={t('close')} onClick={onClose} disabled={busy}>
            <X size={16} />
          </button>
        </header>
        <div className="task-dialog__body">
          <section className="branch-create-source" aria-label={t('newBranchStartingPoint')}>
            <span className="branch-create-source__icon">
              {source.remote ? <Radio size={15} /> : <GitBranch size={15} />}
            </span>
            <span>
              <small>{t('sourceBranch')}</small>
              <strong>{source.branch}</strong>
              <em>{sourceDescription}</em>
            </span>
            <span>
              <small>{t('sourceRevision')}</small>
              <span className="branch-create-source__revision">
                <code>{source.revision.slice(0, 8)}</code>
                <GitCommitHorizontal size={12} />
              </span>
            </span>
          </section>
          <label className="field-stack">
            <span>{t('branchName')}</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="feature/scene-streaming"
              required
            />
            <small>{t('creationWorkspaceAttachNewBranch_02b4')}</small>
          </label>
        </div>
        <footer className="task-dialog__footer">
          <button type="button" onClick={onClose} disabled={busy}>
            {t('cancel')}
          </button>
          <button className="is-primary" type="submit" disabled={busy || !name.trim()}>
            {busy ? <LoaderCircle className="is-spinning" size={14} /> : <Plus size={14} />}
            创建
          </button>
        </footer>
      </form>
    </div>
  )
}
