import { PanelsTopLeft, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { AppIcon } from '../../shared/ui'
import type { LoreRuntimeInfo } from '../../types'
import { loadApplicationVersion } from '../appVersion'
import { ProjectRepositoryLink } from './ProjectRepositoryLink'

/** 应用与嵌入式 Lore Core 的可诊断版本信息。 */
export function AboutDialog({ runtimeInfo, onClose }: { runtimeInfo: LoreRuntimeInfo | null; onClose: () => void }) {
  const { t } = useTranslation()
  const [applicationVersion, setApplicationVersion] = useState<string | null>()

  useEffect(() => {
    let active = true

    void loadApplicationVersion().then((version) => {
      // 弹窗可能在原生 IPC 返回前关闭；卸载后不再写入状态，避免保留无效的异步更新。
      if (active) setApplicationVersion(version)
    })

    return () => {
      active = false
    }
  }, [])

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
          <ProjectRepositoryLink className="about-content__repository-link" />
          <dl>
            <div>
              <dt>{t('applicationVersion')}</dt>
              <dd>{applicationVersion === undefined ? t('loading') : (applicationVersion ?? '—')}</dd>
            </div>
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
