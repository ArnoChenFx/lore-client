import { CloudCog, FolderOpen, LoaderCircle, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { t } from '../../../i18n'
import { AppIcon } from '../../../shared/ui'

interface RepositoryWelcomeProps {
  busyLabel: string | null
  onOpen: () => void
  onOpenServer: () => void
}

/**
 * Tauri 首次启动时的真实空状态。
 *
 * 浏览器演示仍保留丰富示例数据；桌面运行时则明确要求用户选择仓库，
 * 避免真实读取失败后看似成功地退回虚构数据。
 */
export function RepositoryWelcome({ busyLabel, onOpen, onOpenServer }: RepositoryWelcomeProps) {
  const { t } = useTranslation()
  return (
    <section className="repository-welcome">
      <span className="repository-welcome__mark">
        <AppIcon label="Lore Client" />
      </span>
      <span className="panel-header__eyebrow">{t('loreWorkspace')}</span>
      <h1>{t('openOrInitializeALoreProject')}</h1>
      <div className="repository-welcome__actions">
        <button type="button" onClick={onOpen} disabled={Boolean(busyLabel)}>
          {busyLabel ? <LoaderCircle className="is-spinning" size={16} /> : <FolderOpen size={16} />}
          {busyLabel ?? t('chooseAProjectDirectory')}
        </button>
        <button type="button" className="is-secondary" onClick={onOpenServer} disabled={Boolean(busyLabel)}>
          <CloudCog size={16} />
          {t('browseRemoteRepositories')}
        </button>
      </div>
      <small>
        <ShieldCheck size={13} />
        {t('ordinaryDirectoriesAskConfirmationFirst_9abc')}
      </small>
    </section>
  )
}
