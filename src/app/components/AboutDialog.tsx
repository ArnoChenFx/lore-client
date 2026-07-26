import { PanelsTopLeft, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { t } from '../../i18n'
import { AppIcon } from '../../shared/ui'
import type { LoreRuntimeInfo } from '../../types'

/** 应用与嵌入式 Lore Core 的可诊断版本信息。 */
export function AboutDialog({ runtimeInfo, onClose }: { runtimeInfo: LoreRuntimeInfo | null; onClose: () => void }) {
  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section className="task-dialog compact-dialog" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <header className="task-dialog__header">
          <span className="task-dialog__mark">
            <PanelsTopLeft size={18} />
          </span>
          <span>
            <small>ABOUT</small>
            <h2 id="about-title">Lore Client</h2>
          </span>
          <button type="button" aria-label={t('closeAbout')} onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="about-content">
          <AppIcon className="about-content__app-icon" label="Lore Client" />
          <p>{t('nativeDesktopClientLoreVersion_58a8')}</p>
          <dl>
            <div>
              <dt>Lore Core</dt>
              <dd>{runtimeInfo?.libraryVersion ?? t('loading')}</dd>
            </div>
            <div>
              <dt>{t('integration')}</dt>
              <dd>{runtimeInfo?.integrationMode ?? '—'}</dd>
            </div>
            <div>
              <dt>{t('sourceRevision')}</dt>
              <dd>
                <code>{runtimeInfo?.sourceRevision?.slice(0, 12) ?? '—'}</code>
              </dd>
            </div>
          </dl>
        </div>
      </section>
    </div>
  )
}
