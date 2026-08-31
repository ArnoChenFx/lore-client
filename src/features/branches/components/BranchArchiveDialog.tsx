import { Archive, LoaderCircle, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { t } from '../../../i18n'
import { CheckboxInput } from '../../../shared/ui'
import type { Branch } from '../../../types'

interface BranchArchiveDialogProps {
  busy: boolean
  branch: Branch
  onConfirm: (includeLayers: boolean) => void
  onClose: () => void
}

/**
 * 分支归档确认弹层。
 *
 * Lore 0.9.0 起归档可以选择同时归档每个已配置 Layer 中的同名 Branch；该范围
 * 是一次明确的写操作放大，必须由用户在确认弹窗中显式勾选，适配层与菜单入口
 * 都不会默认递归。
 */
export function BranchArchiveDialog({ busy, branch, onConfirm, onClose }: BranchArchiveDialogProps) {
  const { t } = useTranslation()
  const [includeLayers, setIncludeLayers] = useState(false)

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <div className="task-dialog compact-dialog" role="dialog" aria-modal="true" aria-label={t('archiveBranch_2')}>
        <header className="task-dialog__header">
          <span className="task-dialog__mark">
            <Archive size={18} />
          </span>
          <span>
            <small>{t('pointer')}</small>
            <h2>{t('archiveBranch_2')}</h2>
          </span>
          <button type="button" aria-label={t('close')} onClick={onClose} disabled={busy}>
            <X size={16} />
          </button>
        </header>
        <div className="task-dialog__body">
          <p className="archive-dialog__impact">{t('confirm.archiveBranch', { name: branch.name })}</p>
          <p className="archive-dialog__impact">
            <small>{t('loreRemovesLocallyVisiblePointer_bb62')}</small>
          </p>
          <label className="field-stack">
            <span className="field-inline">
              <CheckboxInput
                checked={includeLayers}
                onChange={(event) => setIncludeLayers(event.target.checked)}
                disabled={busy}
              />
              <span>{t('archiveIncludeLayers')}</span>
            </span>
            <small>{t('archiveIncludeLayersHint')}</small>
          </label>
        </div>
        <footer className="task-dialog__footer">
          <button type="button" onClick={onClose} disabled={busy}>
            {t('cancel')}
          </button>
          <button className="is-primary" type="button" onClick={() => onConfirm(includeLayers)} disabled={busy}>
            {busy ? <LoaderCircle className="is-spinning" size={14} /> : <Archive size={14} />}
            {t('archiveBranch')}
          </button>
        </footer>
      </div>
    </div>
  )
}