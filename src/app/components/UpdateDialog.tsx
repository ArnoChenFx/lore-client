import { Download, RefreshCw, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { calculateUpdateProgress, isUpdateBusy, type AppUpdateState } from '../appUpdater'
import { ProjectReleasesLink } from './ProjectRepositoryLink'

interface UpdateDialogProps {
  state: AppUpdateState
  onInstall: () => void
  onClose: () => void
}

/**
 * 更新说明来自远端发布清单，因此只映射需要额外安全约束的 Markdown 元素。
 * react-markdown 默认不会执行原始 HTML；链接统一使用隔离的新窗口，图片则只显示替代
 * 文本，避免打开更新弹窗时静默请求正文里的外部跟踪资源。
 */
const releaseNotesMarkdownComponents: Components = {
  a({ children, href, title }) {
    return (
      <a href={href} title={title} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    )
  },
  img({ alt }) {
    return alt ? <span className="update-dialog__notes-image-alt">{alt}</span> : null
  }
}

/** 在终止并重启应用前明确展示目标版本、发布说明与当前下载状态。 */
export function UpdateDialog({ state, onInstall, onClose }: UpdateDialogProps) {
  const { t } = useTranslation()
  const busy = isUpdateBusy(state.phase)
  // 下载或安装失败后 Updater 资源仍然有效，允许用户在同一弹窗中重新发起完整流程。
  const isInstallRetry = state.phase === 'error' && state.errorKind === 'install'
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
            <div className="update-dialog__version--available">
              <dt>{t('availableVersion')}</dt>
              <dd>{state.availableVersion || '—'}</dd>
              {/* 发布页与可用版本属于同一上下文，图标入口固定在该单元格右侧。 */}
              <ProjectReleasesLink className="update-dialog__releases-link" />
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
              <div className="update-dialog__notes-markdown">
                <Markdown remarkPlugins={[remarkGfm]} components={releaseNotesMarkdownComponents} skipHtml>
                  {state.notes}
                </Markdown>
              </div>
            </section>
          )}
        </div>
        <footer className="task-dialog__footer">
          <button type="button" disabled={busy} onClick={onClose}>
            {t('remindMeLater')}
          </button>
          <button
            type="button"
            className="is-primary"
            disabled={busy || (state.phase === 'error' && !isInstallRetry)}
            onClick={onInstall}
          >
            <Download size={14} />
            {busy ? status : isInstallRetry ? t('retryDownloadInstallAndRestart') : t('downloadInstallAndRestart')}
          </button>
        </footer>
      </section>
    </div>
  )
}
