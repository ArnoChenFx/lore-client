import { CheckCircle2, CloudCog, Database, LoaderCircle, LogIn, RefreshCw, Server, GitFork, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { t } from '../../../i18n'
import { IconButton, SelectInput } from '../../../shared/ui'
import type { LoreAuthIdentity, RemoteRepository } from '../../../types'

interface ServerDialogProps {
  /** 仅用于当前弹层的浏览目标，不代表仓库持久化配置。 */
  browserServerUrl: string
  repositories: RemoteRepository[]
  loading: boolean
  error: string | null
  identities: LoreAuthIdentity[]
  selectedUserId: string
  onBrowserServerUrlChange: (serverUrl: string) => void
  onSelectedUserIdChange: (userId: string) => void
  onAuthenticate: () => void
  onRefresh: () => void
  onClone: (repository: RemoteRepository) => void
  onClose: () => void
}

/**
 * Lore 服务器连接面板。
 *
 * 当前面板只展示服务器公开的仓库目录；打开工作区仍要求用户明确选择本地目录，
 * 因而不会因为浏览服务器而意外写入磁盘或远端数据。
 */
export function ServerDialog({
  browserServerUrl,
  repositories,
  loading,
  error,
  identities,
  selectedUserId,
  onBrowserServerUrlChange,
  onSelectedUserIdChange,
  onAuthenticate,
  onRefresh,
  onClone,
  onClose
}: ServerDialogProps) {
  const { t } = useTranslation()
  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <section className="server-dialog" role="dialog" aria-modal="true" aria-labelledby="server-dialog-title">
        <header className="server-dialog__header">
          <span className="server-dialog__icon">
            <CloudCog size={18} />
          </span>
          <span>
            <small>LORE REMOTE</small>
            <h2 id="server-dialog-title">{t('serverRepositories')}</h2>
          </span>
          <IconButton icon={<X size={16} />} label={t('closeServerPanel')} onClick={onClose} />
        </header>

        <div className="server-dialog__connection">
          <label htmlFor="lore-server-url">{t('browseServerAddress')}</label>
          <div className="composite-input">
            <span className="server-dialog__protocol">
              <Server size={15} />
            </span>
            <input
              id="lore-server-url"
              value={browserServerUrl}
              spellCheck={false}
              onChange={(event) => onBrowserServerUrlChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  onRefresh()
                }
              }}
            />
            <button type="button" onClick={onRefresh} disabled={loading}>
              {loading ? <LoaderCircle className="is-spinning" size={15} /> : <RefreshCw size={15} />}
              {loading ? t('connecting') : t('refresh')}
            </button>
          </div>
          <div className="server-dialog__account">
            <label htmlFor="lore-server-account">{t('authenticationAccount')}</label>
            <SelectInput
              id="lore-server-account"
              value={selectedUserId}
              disabled={loading}
              onChange={(event) => onSelectedUserIdChange(event.target.value)}
            >
              <option value="">{t('automaticAccountSelection')}</option>
              {[...new Map(identities.map((identity) => [identity.userId, identity])).values()].map((identity) => (
                <option key={`${identity.authUrl}:${identity.userId}`} value={identity.userId}>
                  {identity.displayName || identity.userId} · {identity.authUrl}
                </option>
              ))}
            </SelectInput>
            <button type="button" disabled={loading || !browserServerUrl.trim()} onClick={onAuthenticate}>
              <LogIn size={14} />
              {t('authenticate')}
            </button>
          </div>
        </div>

        <div className="server-dialog__result">
          <div className="server-dialog__summary">
            <span>
              {error ? <CloudCog size={14} /> : <CheckCircle2 size={14} />}
              {error
                ? t('connectionIncomplete')
                : t('status.connectedRepositories', {
                    count: repositories.length
                  })}
            </span>
          </div>

          {error ? (
            <div className="server-dialog__empty is-error">
              <CloudCog size={22} />
              <strong>{t('unableToLoadRepositoryDirectory')}</strong>
              <p>{error}</p>
            </div>
          ) : repositories.length > 0 ? (
            <ul className="server-dialog__repositories">
              {repositories.map((repository) => (
                <li key={repository.id}>
                  <span>
                    <Database size={15} />
                  </span>
                  <div className="server-dialog__repository-identity">
                    <strong>{repository.name}</strong>
                    {repository.description ? (
                      <small title={repository.description}>{repository.description}</small>
                    ) : null}
                  </div>
                  <code title={repository.id}>{shortIdentifier(repository.id)}</code>
                  <button type="button" onClick={() => onClone(repository)}>
                    <GitFork size={14} />
                    {t('clone')}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="server-dialog__empty">
              {loading ? <LoaderCircle className="is-spinning" size={22} /> : <Database size={22} />}
              <strong>{loading ? t('loadingDirectory') : t('theServerHasNoPublicRepositories')}</strong>
              <p>
                {loading
                  ? t('loreCoreConnectingRequestingRepository_ec6f')
                  : t('connectedSuccessfullyButRepositoryList_e07f')}
              </p>
            </div>
          )}
        </div>

        <footer className="server-dialog__footer">{t('cloneWritesLocalDirectoryYou_a431')}</footer>
      </section>
    </div>
  )
}

function shortIdentifier(identifier: string): string {
  return identifier.length > 16 ? `${identifier.slice(0, 8)}…${identifier.slice(-6)}` : identifier
}
