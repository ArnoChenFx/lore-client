import { CloudOff, LoaderCircle, LogIn, ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { TextButton } from '../../../shared/ui'
import type { RemoteAuthenticationTarget } from '../remoteAuthentication'

interface RemoteAuthenticationDialogProps {
  target: RemoteAuthenticationTarget
  busy: boolean
  error: string | null
  onAuthenticate: () => void
  onContinueOffline: () => void
}

/** 强制用户在重新认证与明确离线之间做选择，避免凭据失效后只能重启应用。 */
export function RemoteAuthenticationDialog({
  target,
  busy,
  error,
  onAuthenticate,
  onContinueOffline
}: RemoteAuthenticationDialogProps) {
  const { t } = useTranslation()
  const errorMessage =
    error === 'authentication_still_required'
      ? t('authenticationStillRequired')
      : error === 'authentication_verification_failed'
        ? t('authenticationVerificationFailed')
        : error

  return (
    <div className="dialog-backdrop remote-authentication-backdrop" role="presentation">
      <section
        className="task-dialog compact-dialog remote-authentication-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-authentication-title"
        aria-describedby="remote-authentication-description"
      >
        <header className="task-dialog__header">
          <span className="task-dialog__mark">
            <ShieldAlert size={18} />
          </span>
          <span>
            <small>{t('remoteAccess')}</small>
            <h2 id="remote-authentication-title">{t('remoteAuthenticationExpired')}</h2>
          </span>
        </header>
        <div className="task-dialog__body remote-authentication-dialog__body">
          <p id="remote-authentication-description">{t('remoteAuthenticationExpiredDescription')}</p>
          <dl>
            <div>
              <dt>{t('remoteServer')}</dt>
              <dd>{target.serverUrl}</dd>
            </div>
            {target.repositoryNames.length > 0 && (
              <div>
                <dt>{t('affectedRepositories')}</dt>
                <dd>{target.repositoryNames.join(', ')}</dd>
              </div>
            )}
          </dl>
          <p className="remote-authentication-dialog__offline-hint">
            <CloudOff size={15} />
            <span>{t('continueOfflineDescription')}</span>
          </p>
          {errorMessage && (
            <p className="remote-authentication-dialog__error" role="alert">
              {errorMessage}
            </p>
          )}
        </div>
        <footer className="task-dialog__footer">
          <TextButton disabled={busy} onClick={onContinueOffline}>
            <CloudOff size={14} />
            {t('skipAndContinueOffline')}
          </TextButton>
          <TextButton variant="primary" disabled={busy} onClick={onAuthenticate}>
            {busy ? <LoaderCircle className="is-spinning" size={14} /> : <LogIn size={14} />}
            {busy ? t('authenticating') : t('reauthenticate')}
          </TextButton>
        </footer>
      </section>
    </div>
  )
}
