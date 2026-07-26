import { KeyRound, LoaderCircle, LogIn, LogOut, Plus, RefreshCw, ShieldAlert, Trash2, UserRound } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ControlInput, IconButton, SelectInput, TextButton, TextInput } from '../../../shared/ui'
import type { LoreAuthIdentity, Repository, RepositoryAuthAccountBinding } from '../../../types'

interface AuthAccountsPanelProps {
  remoteUrl: string
  disabled: boolean
  repositories: Repository[]
  bindings: RepositoryAuthAccountBinding[]
  onList: () => Promise<LoreAuthIdentity[]>
  onLoginInteractive: (remoteUrl: string) => Promise<boolean>
  onLoginWithToken: (remoteUrl: string, token: string, tokenType: string, authUrl?: string) => Promise<boolean>
  onLogout: (identity: LoreAuthIdentity) => Promise<boolean>
  onClear: () => Promise<boolean>
  onBindingChange: (repository: Repository, identity?: LoreAuthIdentity) => Promise<boolean>
}

export function authIdentityKey(identity: Pick<LoreAuthIdentity, 'authUrl' | 'userId'>): string {
  return `${encodeURIComponent(identity.authUrl)}|${encodeURIComponent(identity.userId)}`
}

/** 把 Lore 的认证条目和多个资源授权合并为一个可选择的设备账户。 */
export function consolidateAuthIdentities(identities: LoreAuthIdentity[]): LoreAuthIdentity[] {
  const accounts = new Map<string, LoreAuthIdentity>()
  for (const identity of identities) {
    const key = authIdentityKey(identity)
    const current = accounts.get(key)
    if (!current) {
      accounts.set(key, {
        ...identity,
        authorizedDomains: [...identity.authorizedDomains]
      })
      continue
    }
    accounts.set(key, {
      ...current,
      displayName: current.displayName || identity.displayName,
      resource: [current.resource, identity.resource].filter(Boolean).join(', '),
      authorizedDomains: [...new Set([...current.authorizedDomains, ...identity.authorizedDomains])],
      expiresAt: Math.max(current.expiresAt ?? 0, identity.expiresAt ?? 0) || undefined
    })
  }
  return [...accounts.values()].sort((left, right) =>
    (left.displayName || left.userId).localeCompare(right.displayName || right.userId)
  )
}

/** 设备级账户中心：JWT 留在 Lore Token Store，界面只管理脱敏账户与仓库绑定。 */
export function AuthAccountsPanel({
  remoteUrl,
  disabled,
  repositories,
  bindings,
  onList,
  onLoginInteractive,
  onLoginWithToken,
  onLogout,
  onClear,
  onBindingChange
}: AuthAccountsPanelProps) {
  const { t } = useTranslation()
  const [identities, setIdentities] = useState<LoreAuthIdentity[]>([])
  const [selectedKey, setSelectedKey] = useState('')
  const [detailTab, setDetailTab] = useState<'account' | 'repositories'>('account')
  const [addingAccount, setAddingAccount] = useState(false)
  const [remoteDraft, setRemoteDraft] = useState(remoteUrl)
  const [authUrl, setAuthUrl] = useState('')
  const [tokenType, setTokenType] = useState('Bearer')
  const [token, setToken] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const accounts = useMemo(() => consolidateAuthIdentities(identities), [identities])
  const selectedAccount = accounts.find((identity) => authIdentityKey(identity) === selectedKey) ?? accounts[0]

  useEffect(() => {
    if (!remoteDraft.trim() && remoteUrl.trim()) setRemoteDraft(remoteUrl)
  }, [remoteDraft, remoteUrl])

  const refresh = async () => {
    setPending(true)
    setError('')
    try {
      const next = await onList()
      setIdentities(next)
      const nextAccounts = consolidateAuthIdentities(next)
      if (!nextAccounts.some((identity) => authIdentityKey(identity) === selectedKey)) {
        setSelectedKey(nextAccounts[0] ? authIdentityKey(nextAccounts[0]) : '')
      }
    } catch (loadError) {
      setIdentities([])
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setPending(false)
    }
  }

  useEffect(() => {
    void refresh()
    // 账户列表是设备级缓存，只在面板挂载时自动读取一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const interactiveLogin = async () => {
    setPending(true)
    const succeeded = await onLoginInteractive(remoteDraft)
    if (succeeded) {
      setAddingAccount(false)
      await refresh()
    } else {
      setPending(false)
    }
  }

  const tokenLogin = async () => {
    /*
     * Token 只停留在 password 输入的短生命周期 state；IPC Promise 建立后立即
     * 清空，绝不写入偏好、Toast、错误详情或账户 DTO。
     */
    const oneTimeToken = token
    setToken('')
    setPending(true)
    const succeeded = await onLoginWithToken(remoteDraft, oneTimeToken, tokenType, authUrl)
    if (succeeded) {
      setAddingAccount(false)
      await refresh()
    } else {
      setPending(false)
    }
  }

  return (
    <div className="auth-accounts">
      <div className="lock-management__notice">
        <ShieldAlert size={16} />
        <span>
          <strong>{t('credentialBoundary')}</strong>
          <small>{t('credentialBoundaryHint')}</small>
        </span>
      </div>

      <section className="auth-account-manager">
        <aside className="auth-account-manager__sidebar">
          <header>
            <strong>{t('accounts')}</strong>
            <IconButton
              icon={<Plus size={14} />}
              label={t('addAccount')}
              disabled={disabled || pending}
              onClick={() => {
                setAddingAccount(true)
                setDetailTab('account')
              }}
            />
          </header>
          <div className="auth-account-manager__accounts" role="list">
            {accounts.map((identity) => {
              const key = authIdentityKey(identity)
              const selected = !addingAccount && key === authIdentityKey(selectedAccount ?? identity)
              return (
                <button
                  key={key}
                  type="button"
                  className={selected ? 'is-selected' : undefined}
                  aria-pressed={selected}
                  onClick={() => {
                    setSelectedKey(key)
                    setAddingAccount(false)
                  }}
                >
                  <UserRound size={17} />
                  <span>
                    <strong>{identity.displayName || identity.userId}</strong>
                    <small>{identity.authUrl}</small>
                  </span>
                </button>
              )
            })}
            {accounts.length === 0 && (
              <div className="auth-account-manager__empty">
                <UserRound size={22} />
                <small>{t('noStoredLoreIdentities')}</small>
              </div>
            )}
          </div>
          <button
            type="button"
            className="auth-account-manager__refresh"
            disabled={pending}
            onClick={() => void refresh()}
          >
            <RefreshCw className={pending ? 'spin' : undefined} size={13} />
            {t('refresh')}
          </button>
        </aside>

        <div className="auth-account-manager__detail">
          <header className="auth-account-manager__identity">
            <UserRound size={28} />
            <span>
              <strong>
                {addingAccount
                  ? t('addLoreAccount')
                  : selectedAccount?.displayName || selectedAccount?.userId || t('noAccountSelected')}
              </strong>
              <small>{addingAccount ? t('signInToAccessRemoteRepositories') : selectedAccount?.authUrl}</small>
            </span>
          </header>

          {!addingAccount && selectedAccount && (
            <div className="auth-account-manager__tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={detailTab === 'account'}
                onClick={() => setDetailTab('account')}
              >
                {t('account')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={detailTab === 'repositories'}
                onClick={() => setDetailTab('repositories')}
              >
                {t('repositories')}
              </button>
            </div>
          )}

          {(addingAccount || !selectedAccount) && (
            <div className="auth-account-manager__login">
              <label>
                <span>{t('remoteServer')}</span>
                <TextInput
                  value={remoteDraft}
                  placeholder="lore://127.0.0.1:41337"
                  onChange={(event) => setRemoteDraft(event.target.value)}
                />
                <small>{t('accountRemoteServerHint')}</small>
              </label>
              <TextButton
                variant="primary"
                disabled={disabled || pending || !remoteDraft.trim()}
                onClick={() => void interactiveLogin()}
              >
                {pending ? <LoaderCircle className="spin" size={14} /> : <LogIn size={14} />}
                {t('signInWithBrowser')}
              </TextButton>
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  void tokenLogin()
                }}
              >
                <header>
                  <KeyRound size={14} />
                  <strong>{t('oneTimeTokenLogin')}</strong>
                </header>
                <label>
                  <span>{t('tokenType')}</span>
                  <TextInput value={tokenType} onChange={(event) => setTokenType(event.target.value)} />
                </label>
                <label>
                  <span>{t('authServiceUrlOptional')}</span>
                  <TextInput value={authUrl} onChange={(event) => setAuthUrl(event.target.value)} />
                </label>
                <label className="is-wide">
                  <span>{t('accessToken')}</span>
                  <ControlInput
                    type="password"
                    autoComplete="off"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                  />
                </label>
                <footer>
                  <small>{t('tokenNeverReturnedOrPersisted')}</small>
                  <TextButton type="submit" disabled={disabled || pending || !remoteDraft.trim() || !token.trim()}>
                    {t('signInWithToken')}
                  </TextButton>
                </footer>
              </form>
            </div>
          )}

          {!addingAccount && selectedAccount && detailTab === 'account' && (
            <div className="auth-account-manager__facts">
              <dl>
                <div>
                  <dt>{t('authenticationService')}</dt>
                  <dd>{selectedAccount.authUrl}</dd>
                </div>
                <div>
                  <dt>{t('userId')}</dt>
                  <dd>{selectedAccount.userId}</dd>
                </div>
                <div>
                  <dt>{t('authorizedResources')}</dt>
                  <dd>{selectedAccount.resource || t('authenticationIdentity')}</dd>
                </div>
                <div>
                  <dt>{t('authorizedDomains')}</dt>
                  <dd>{selectedAccount.authorizedDomains.join(', ') || t('noAuthorizedDomains')}</dd>
                </div>
                <div>
                  <dt>{t('expiresAt')}</dt>
                  <dd>
                    {selectedAccount.expiresAt
                      ? new Intl.DateTimeFormat(undefined, {
                          dateStyle: 'medium',
                          timeStyle: 'short'
                        }).format(selectedAccount.expiresAt)
                      : t('expiryUnavailable')}
                  </dd>
                </div>
              </dl>
              <div className="auth-account-manager__actions">
                <TextButton
                  disabled={disabled || pending}
                  onClick={async () => {
                    setPending(true)
                    const succeeded = await onLogout(selectedAccount)
                    if (succeeded) await refresh()
                    else setPending(false)
                  }}
                >
                  <LogOut size={13} />
                  {t('signOut')}
                </TextButton>
              </div>
            </div>
          )}

          {!addingAccount && selectedAccount && detailTab === 'repositories' && (
            <div className="auth-account-manager__repositories">
              <p>{t('repositoryAccountBindingHint')}</p>
              {repositories.map((repository) => {
                const binding = bindings.find(
                  (candidate) => candidate.repositoryPath.toLocaleLowerCase() === repository.path.toLocaleLowerCase()
                )
                const value = binding ? authIdentityKey(binding) : ''
                return (
                  <label key={repository.id}>
                    <span>
                      <strong>{repository.name}</strong>
                      <small>{repository.path}</small>
                    </span>
                    <SelectInput
                      value={value}
                      disabled={disabled || pending}
                      aria-label={t('repositoryAccount')}
                      onChange={async (event) => {
                        const identity = accounts.find(
                          (candidate) => authIdentityKey(candidate) === event.currentTarget.value
                        )
                        setPending(true)
                        await onBindingChange(repository, identity)
                        setPending(false)
                      }}
                    >
                      <option value="">{t('automaticAccountSelection')}</option>
                      {binding && !accounts.some((identity) => authIdentityKey(identity) === value) && (
                        <option value={value} disabled>
                          {binding.userId} · {t('accountUnavailable')}
                        </option>
                      )}
                      {accounts.map((identity) => (
                        <option key={authIdentityKey(identity)} value={authIdentityKey(identity)}>
                          {identity.displayName || identity.userId} · {identity.authUrl}
                        </option>
                      ))}
                    </SelectInput>
                  </label>
                )
              })}
              <div className="auth-account-manager__identity-warning">
                <ShieldAlert size={15} />
                <span>{t('boundAccountRevisionIdentityHint')}</span>
              </div>
            </div>
          )}
        </div>
      </section>

      <div className="composition-removal is-danger">
        <Trash2 size={15} />
        <div>
          <strong>{t('clearAllLoreCredentials')}</strong>
          <small>{t('clearAllLoreCredentialsHint')}</small>
        </div>
        <TextButton
          variant="danger"
          disabled={disabled || pending || accounts.length === 0}
          onClick={async () => {
            setPending(true)
            const succeeded = await onClear()
            if (succeeded) await refresh()
            else setPending(false)
          }}
        >
          {t('clearAll')}
        </TextButton>
      </div>

      {error && <p className="settings-feedback is-warning">{error}</p>}
    </div>
  )
}
