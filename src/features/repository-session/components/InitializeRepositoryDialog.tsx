import { Database, FileText, FolderPlus, LoaderCircle, ShieldCheck, UserRound, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAdjustFromProps } from '../../../hooks/useAdjustFromProps'
import { formatCommitIdentity, parseCommitIdentity } from '../../../shared/lib'
import { CheckboxInput, TextInput } from '../../../shared/ui'
import type { LoreRepositoryInitializeOptions, LoreSharedStoreInfo } from '../../../types'

interface InitializeRepositoryDialogProps {
  directoryPath: string
  defaultIdentity: string
  sharedStoreInfo: LoreSharedStoreInfo | null
  busy: boolean
  error: string | null
  onConfirm: (
    repositoryName: string,
    description: string,
    repositoryIdentity: string,
    options: LoreRepositoryInitializeOptions
  ) => void
  onClose: () => void
}

/**
 * 普通目录的 Lore 初始化确认入口。
 *
 * 表单只收集稳定的仓库元数据；目录存在性、祖先仓库探测、名称规则和 `.lore`
 * 覆盖保护全部由 Rust 再次校验，不能依赖前端状态承担数据安全边界。
 */
export function InitializeRepositoryDialog({
  directoryPath,
  defaultIdentity,
  sharedStoreInfo,
  busy,
  error,
  onConfirm,
  onClose
}: InitializeRepositoryDialogProps) {
  const { t } = useTranslation()
  const suggestedName = useMemo(() => suggestRepositoryName(directoryPath), [directoryPath])
  const defaultIdentityParts = useMemo(() => parseCommitIdentity(defaultIdentity), [defaultIdentity])
  const [repositoryName, setRepositoryName] = useState(suggestedName)
  const [description, setDescription] = useState('')
  // 默认身份直接填入表单，用户清空后才会让新仓库保持无 identity 配置。
  const [repositoryIdentityName, setRepositoryIdentityName] = useState(() => defaultIdentityParts.name)
  const [repositoryIdentityEmail, setRepositoryIdentityEmail] = useState(() => defaultIdentityParts.email)
  const automaticSharedStore = sharedStoreInfo?.useAutomatically ?? false
  const [useSharedStore, setUseSharedStore] = useState(automaticSharedStore)
  const [sharedStorePath, setSharedStorePath] = useState('')
  const repositoryIdentity = formatCommitIdentity(repositoryIdentityName, repositoryIdentityEmail)

  // 目录、默认身份或自动开关变化时重置整个表单草稿；key 覆盖原 effect 的全部依赖，
  // 值相同时不触碰用户草稿。
  const formResetKey = `${directoryPath}|${defaultIdentityParts.name}|${defaultIdentityParts.email}|${automaticSharedStore}|${suggestedName}`
  useAdjustFromProps(formResetKey, () => {
    setRepositoryName(suggestedName)
    setDescription('')
    setRepositoryIdentityName(defaultIdentityParts.name)
    setRepositoryIdentityEmail(defaultIdentityParts.email)
    // 新一次初始化沿用设备级自动开关，但不复用上一次表单的路径草稿。
    setUseSharedStore(automaticSharedStore)
    setSharedStorePath('')
  })

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <form
        className="task-dialog initialize-repository-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="initialize-repository-title"
        onSubmit={(event) => {
          event.preventDefault()
          if (repositoryName.trim()) {
            onConfirm(repositoryName.trim(), description.trim(), repositoryIdentity.trim(), {
              useSharedStore,
              sharedStorePath: useSharedStore ? sharedStorePath.trim() || undefined : undefined
            })
          }
        }}
      >
        <header className="task-dialog__header">
          <span className="task-dialog__mark">
            <FolderPlus size={18} />
          </span>
          <span>
            <small>LORE INIT</small>
            <h2 id="initialize-repository-title">{t('initializeLoreRepository')}</h2>
          </span>
          <button type="button" aria-label={t('closeInitializationDialog')} onClick={onClose} disabled={busy}>
            <X size={16} />
          </button>
        </header>

        <div className="task-dialog__body initialize-repository-dialog__body">
          <section className="initialize-repository-dialog__directory">
            <FolderPlus size={16} />
            <span>
              <small>{t('initializeDirectory')}</small>
              <code title={directoryPath}>{directoryPath}</code>
            </span>
          </section>

          <label className="field-stack">
            <span>{t('repositoryName')}</span>
            <input
              autoFocus
              value={repositoryName}
              maxLength={1000}
              spellCheck={false}
              pattern="[A-Za-z0-9._-]+"
              title={t('asciiLettersNumbersHyphensUnderscores_88f6')}
              onChange={(event) => setRepositoryName(event.target.value)}
              required
            />
            <small>{t('usedLoreLocalMetadataLetters_4872')}</small>
          </label>

          <label className="field-stack">
            <span>
              <FileText size={13} />
              {t('repositoryDescriptionOptional')}
            </span>
            <textarea
              value={description}
              maxLength={4096}
              rows={3}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t('describeProjectPurposeContentScope_432a')}
            />
          </label>

          <div className="field-stack">
            <span>
              <UserRound size={13} />
              {t('repositoryAuthorAndEmailOptional')}
            </span>
            <div className="initialize-identity-fields">
              <label>
                <span>{t('authorName')}</span>
                <input
                  value={repositoryIdentityName}
                  maxLength={240}
                  spellCheck={false}
                  placeholder={defaultIdentityParts.name || t('exampleAuthorName')}
                  aria-label={t('newRepositoryCommitAuthor')}
                  onChange={(event) => setRepositoryIdentityName(event.target.value.replace(/[\r\n]/g, ''))}
                />
              </label>
              <label>
                <span>{t('email')}</span>
                <input
                  type="email"
                  value={repositoryIdentityEmail}
                  maxLength={254}
                  spellCheck={false}
                  placeholder={defaultIdentityParts.email || t('exampleAuthorEmail')}
                  aria-label={t('newRepositoryCommitEmail')}
                  onChange={(event) => setRepositoryIdentityEmail(event.target.value.replace(/[\r\n]/g, ''))}
                />
              </label>
            </div>
            <small>
              {repositoryIdentity.trim()
                ? t('valueWrittenNewRepositoryConfiguration_d9b4')
                : defaultIdentity.trim()
                  ? t('status.keepClientDefaultIdentity', { identity: defaultIdentity.trim() })
                  : t('leaveBlankKeepRepositoryIdentity_5b56')}
            </small>
          </div>

          <label className="initialize-repository-dialog__shared-store">
            <CheckboxInput
              checked={useSharedStore}
              disabled={automaticSharedStore}
              onChange={(event) => setUseSharedStore(event.target.checked)}
            />
            <Database size={16} />
            <span>
              <strong>{t('useSharedStoreForInitialize')}</strong>
              <small>
                {automaticSharedStore ? t('sharedStoreAutomaticInitializeHint') : t('sharedStoreInitializeHint')}
              </small>
            </span>
          </label>

          <label className={`field-stack${!useSharedStore ? ' is-disabled' : ''}`} aria-disabled={!useSharedStore}>
            <span>{t('initializeSharedStorePathOptional')}</span>
            <TextInput
              value={sharedStorePath}
              disabled={!useSharedStore}
              onChange={(event) => setSharedStorePath(event.target.value)}
              placeholder={t('initializeSharedStorePathPlaceholder')}
              spellCheck={false}
            />
            <small>{t('initializeSharedStorePathDescription')}</small>
          </label>

          <div className="initialize-repository-dialog__notice">
            <ShieldCheck size={15} />
            <span>{t('existingFilesDeletedOverwrittenInitialization_7f57')}</span>
          </div>

          {error && (
            <div className="dialog-inline-error" role="alert">
              {error}
            </div>
          )}
        </div>

        <footer className="task-dialog__footer">
          <button type="button" onClick={onClose} disabled={busy}>
            {t('cancel')}
          </button>
          <button className="is-primary" type="submit" disabled={busy || !repositoryName.trim()}>
            {busy ? <LoaderCircle className="is-spinning" size={15} /> : <FolderPlus size={15} />}
            {busy ? t('initializing') : t('initializeInThisDirectory')}
          </button>
        </footer>
      </form>
    </div>
  )
}

/** 把目录名转换成 Lore 能接受的安全建议值，最终规则仍由 Rust 严格校验。 */
function suggestRepositoryName(directoryPath: string): string {
  const segment =
    directoryPath
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1) ?? ''
  const normalized = segment.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return normalized && normalized !== '.' && normalized !== '..' ? normalized : 'repository'
}
