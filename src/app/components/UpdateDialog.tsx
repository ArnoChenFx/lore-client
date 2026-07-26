import { Download, RefreshCw, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { calculateUpdateProgress, isUpdateBusy, type AppUpdateState } from '../appUpdater'

interface UpdateDialogProps {
  state: AppUpdateState
  onInstall: () => void
  onClose: () => void
}

/** 在终止并重启应用前明确展示目标版本、发布说明与当前下载状态。 */
export function UpdateDialog({ state, onInstall, onClose }: UpdateDialogProps) {
  const { t } = useTranslation()
  const busy = isUpdateBusy(state.phase)
  const progress = calculateUpdateProgress(state.downloadedBytes, state.totalBytes)
  const status =
    state.phase === 'downloading'
      ? progress === null
        ? t('downloadingUpdate')
        : t('status.downloadingUpdatePercent', { percent: progress })
      : state.phase === 'installing' || state.phase === 'installed'
        ? t('installingUpdate')
        : state.phase === 'error'
          ? state.errorKind === 'install'
            ? t('updateInstallFailedDescription')
            : t('updateCheckFailedDescription')
          : t('updateReadyDescription')

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="task-dialog compact-dialog update-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-dialog-title"
      >
        <header className="task-dialog__header">
          <span className="task-dialog__mark">
            <RefreshCw size={18} />
          </span>
          <span>
            <small>{t('updateSectionLabel')}</small>
            <h2 id="update-dialog-title">{t('applicationUpdateAvailable')}</h2>
          </span>
          <button type="button" aria-label={t('closeUpdateDialog')} disabled={busy} onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="task-dialog__body update-dialog__body">
          <dl className="update-dialog__versions">
            <div>
              <dt>{t('currentVersion')}</dt>
              <dd>{state.currentVersion || '—'}</dd>
            </div>
            <div>
              <dt>{t('availableVersion')}</dt>
              <dd>{state.availableVersion || '—'}</dd>
            </div>
          </dl>
          <p className={state.phase === 'error' ? 'update-dialog__status is-error' : 'update-dialog__status'}>
            {status}
          </p>
          {state.phase === 'downloading' && (
            <progress
              className="update-dialog__progress"
              max={100}
              value={progress ?? undefined}
              aria-label={t('updateDownloadProgress')}
            />
          )}
          {state.notes && (
            <section className="update-dialog__notes" aria-label={t('releaseNotes')}>
              <strong>{t('releaseNotes')}</strong>
              <p>{state.notes}</p>
            </section>
          )}
        </div>
        <footer className="task-dialog__footer">
          <button type="button" disabled={busy} onClick={onClose}>
            {t('remindMeLater')}
          </button>
          <button type="button" className="is-primary" disabled={busy || state.phase === 'error'} onClick={onInstall}>
            <Download size={14} />
            {busy ? status : t('downloadInstallAndRestart')}
          </button>
        </footer>
      </section>
    </div>
  )
}
