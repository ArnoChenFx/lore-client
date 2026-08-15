import {
  AlertTriangle,
  Database,
  FolderOpen,
  GitCompareArrows,
  Languages,
  LoaderCircle,
  Monitor,
  Moon,
  RefreshCw,
  RotateCcw,
  Settings2,
  SlidersHorizontal,
  Sun,
  UserRound,
  Wrench,
  X
} from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { useAdjustFromProps } from '../../hooks/useAdjustFromProps'
import { t } from '../../i18n'
import { loadApplicationLogInfo, openApplicationLogDirectory } from '../../services/logging'
import { DEFAULT_BINARY_PREVIEW_LIMIT_MIB, MIN_BINARY_PREVIEW_LIMIT_MIB } from '../../services/preferences'
import {
  createCustomExternalTool,
  DEFAULT_EXTERNAL_DIFF_TOOLS,
  DEFAULT_EXTERNAL_MERGE_TOOLS,
  externalToolPreset,
  isExternalToolConfigured
} from '../../shared/lib'
import { formatCommitIdentity, parseCommitIdentity } from '../../shared/lib'
import { CheckboxInput, NumberInput, RevisionAuthorAvatar, SelectInput, TextButton, TextInput } from '../../shared/ui'
import type {
  ApplicationLogInfo,
  ExternalDiffToolKind,
  ExternalDiffToolPreference,
  LanguagePreference,
  LoreSharedStoreInfo,
  ThemePreference
} from '../../types'
import { isUpdateBusy, type AppUpdateState } from '../appUpdater'

interface SettingsDialogProps {
  preference: ThemePreference
  language: LanguagePreference
  automaticallyCheckForUpdates?: boolean
  binaryPreviewLimitMib?: number
  defaultIdentity: string
  externalDiffTools?: ExternalDiffToolPreference[]
  externalMergeTools?: ExternalDiffToolPreference[]
  availableExternalToolIds?: string[]
  initialCategory?: SettingsCategory
  onPreferenceChange: (preference: ThemePreference) => void
  onLanguageChange: (language: LanguagePreference) => void
  onAutomaticallyCheckForUpdatesChange?: (enabled: boolean) => void
  onBinaryPreviewLimitMibChange?: (limitMiB: number) => void
  onDefaultIdentityChange: (identity: string) => void
  onExternalDiffToolsChange?: (tools: ExternalDiffToolPreference[]) => void
  onExternalMergeToolsChange?: (tools: ExternalDiffToolPreference[]) => void
  onChooseExternalDiffExecutable?: () => Promise<string | null>
  sharedStoreInfo?: LoreSharedStoreInfo | null
  sharedStoreLoading?: boolean
  sharedStoreBusy?: boolean
  sharedStoreError?: string | null
  /** Shared Store 新建表单首次挂载时使用的预填值，后续草稿保持独立。 */
  initialSharedStoreRemoteUrl?: string
  onRefreshSharedStores?: () => void
  onChooseSharedStoreParent?: () => Promise<string | null>
  onCreateSharedStore?: (remoteUrl: string, parentPath: string) => void
  onSharedStoreAutomaticChange?: (enabled: boolean) => void
  onResetLayout: () => void
  updateState?: AppUpdateState
  onCheckForUpdates?: () => void
  onShowUpdate?: () => void
  onClose: () => void
}

export type SettingsCategory = 'general' | 'identity' | 'integrations' | 'storage' | 'maintenance'

/** 客户端本地偏好面板；设置会立即应用并由对应 Hook 持久化。 */
export function SettingsDialog({
  preference,
  language,
  automaticallyCheckForUpdates = true,
  binaryPreviewLimitMib = DEFAULT_BINARY_PREVIEW_LIMIT_MIB,
  defaultIdentity,
  externalDiffTools = DEFAULT_EXTERNAL_DIFF_TOOLS,
  externalMergeTools = DEFAULT_EXTERNAL_MERGE_TOOLS,
  availableExternalToolIds = [],
  initialCategory = 'general',
  onPreferenceChange,
  onLanguageChange,
  onAutomaticallyCheckForUpdatesChange = () => undefined,
  onBinaryPreviewLimitMibChange = () => undefined,
  onDefaultIdentityChange,
  onExternalDiffToolsChange = () => undefined,
  onExternalMergeToolsChange = () => undefined,
  onChooseExternalDiffExecutable = async () => null,
  sharedStoreInfo = null,
  sharedStoreLoading = false,
  sharedStoreBusy = false,
  sharedStoreError = null,
  initialSharedStoreRemoteUrl = 'lore://127.0.0.1:41337',
  onRefreshSharedStores = () => undefined,
  onChooseSharedStoreParent = async () => null,
  onCreateSharedStore = () => undefined,
  onSharedStoreAutomaticChange = () => undefined,
  onResetLayout,
  updateState,
  onCheckForUpdates,
  onShowUpdate,
  onClose
}: SettingsDialogProps) {
  const { t } = useTranslation()
  const [identity, setIdentity] = useState(() => parseCommitIdentity(defaultIdentity))
  const [sharedStoreRemoteUrl, setSharedStoreRemoteUrl] = useState(initialSharedStoreRemoteUrl)
  const [sharedStoreParent, setSharedStoreParent] = useState('')
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>(initialCategory)
  const [selectedDiffToolId, setSelectedDiffToolId] = useState(externalDiffTools[0]?.id ?? '')
  const [selectedMergeToolId, setSelectedMergeToolId] = useState(externalMergeTools[0]?.id ?? '')
  const [applicationLogInfo, setApplicationLogInfo] = useState<ApplicationLogInfo | null>(null)
  const [applicationLogLoading, setApplicationLogLoading] = useState(false)
  const [applicationLogLoaded, setApplicationLogLoaded] = useState(false)
  const [applicationLogError, setApplicationLogError] = useState(false)
  const [binaryPreviewLimitDraft, setBinaryPreviewLimitDraft] = useState(String(binaryPreviewLimitMib))
  const lastEmittedIdentityRef = useRef<string | null>(null)

  const themeOptions = [
    { id: 'system' as const, label: t('useSystemSetting'), icon: Monitor },
    { id: 'dark' as const, label: t('dark'), icon: Moon },
    { id: 'light' as const, label: t('light'), icon: Sun }
  ]

  const languageOptions = [
    // 语言选项只展示用户可读名称，内部语言标签不作为界面次级文案暴露。
    { id: 'zh-CN' as const, label: t('simplifiedChinese') },
    { id: 'en-US' as const, label: 'English' }
  ]

  const settingsCategories = [
    {
      id: 'general' as const,
      label: t('clientSettingsGeneral'),
      description: t('clientSettingsGeneralDescription'),
      icon: SlidersHorizontal
    },
    {
      id: 'identity' as const,
      label: t('defaultCommitIdentity'),
      description: t('clientSettingsIdentityDescription'),
      icon: UserRound
    },
    {
      id: 'integrations' as const,
      label: t('clientSettingsIntegrations'),
      description: t('clientSettingsIntegrationsDescription'),
      icon: GitCompareArrows
    },
    {
      id: 'storage' as const,
      label: t('clientSettingsStorage'),
      description: t('clientSettingsStorageDescription'),
      icon: Database
    },
    {
      id: 'maintenance' as const,
      label: t('maintenance'),
      description: t('clientSettingsMaintenanceDescription'),
      icon: Wrench
    }
  ]

  useEffect(() => {
    /*
     * 父组件会把本组件每次编辑后的编码值立即传回。只跳过这一轮回声；真正来自
     * 磁盘水合、清除按钮或外部变更的新值仍重新初始化两个草稿字段。
     */
    if (defaultIdentity === lastEmittedIdentityRef.current) {
      lastEmittedIdentityRef.current = null
      return
    }
    setIdentity(parseCommitIdentity(defaultIdentity))
  }, [defaultIdentity])

  // 磁盘水合或其他设置入口改变偏好时，同步未聚焦输入框显示的已生效整数值；
  // 输入框草稿只在提交时写回，因此外部值变化不会覆盖正在输入的内容。
  useAdjustFromProps(String(binaryPreviewLimitMib), () => {
    setBinaryPreviewLimitDraft(String(binaryPreviewLimitMib))
  })

  // 进入维护页且尚未加载日志信息时，立即标记为加载中；加载完成回调负责复位。
  useAdjustFromProps(activeCategory, () => {
    if (activeCategory === 'maintenance' && !applicationLogLoaded) {
      setApplicationLogLoading(true)
    }
  })

  useEffect(() => {
    /*
     * loading 是本次请求的展示状态，不能作为 Effect 依赖或再次进入的拦截条件。
     * 否则 setApplicationLogLoading(true) 会触发清理函数，把尚未返回的原生命令标记为
     * cancelled，finally 随后也无法复位状态，界面便会永久停留在“正在读取”。
     */
    if (activeCategory !== 'maintenance' || applicationLogLoaded) return
    let cancelled = false
    void loadApplicationLogInfo()
      .then((info) => {
        if (cancelled) return
        setApplicationLogInfo(info)
        setApplicationLogError(false)
      })
      .catch(() => {
        if (!cancelled) setApplicationLogError(true)
      })
      .finally(() => {
        if (!cancelled) {
          setApplicationLogLoading(false)
          setApplicationLogLoaded(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [activeCategory, applicationLogLoaded])

  const openLogDirectory = async () => {
    setApplicationLogError(false)
    try {
      await openApplicationLogDirectory()
    } catch {
      setApplicationLogError(true)
    }
  }

  const updateIdentity = (name: string, email: string) => {
    const next = { name, email, raw: formatCommitIdentity(name, email) }
    setIdentity(next)
    lastEmittedIdentityRef.current = next.raw
    onDefaultIdentityChange(next.raw)
  }

  const commitBinaryPreviewLimit = () => {
    const parsed = Number(binaryPreviewLimitDraft)
    // 保留两位小数精度：0.01 MiB 的区间缩略图调试场景也允许保存。
    const normalized = Number.isFinite(parsed)
      ? Math.max(MIN_BINARY_PREVIEW_LIMIT_MIB, Math.round(parsed * 100) / 100)
      : binaryPreviewLimitMib
    setBinaryPreviewLimitDraft(String(normalized))
    onBinaryPreviewLimitMibChange(normalized)
  }

  const updateExternalTools = (
    mode: 'diff' | 'merge',
    tools: ExternalDiffToolPreference[],
    selectedId: string,
    next: Partial<ExternalDiffToolPreference>
  ) => {
    const updated = tools.map((tool) => {
      if (tool.id !== selectedId) return next.primary ? { ...tool, primary: false } : tool
      return { ...tool, ...next }
    })
    ;(mode === 'diff' ? onExternalDiffToolsChange : onExternalMergeToolsChange)(updated)
  }

  const renderExternalToolGroup = (
    mode: 'diff' | 'merge',
    tools: ExternalDiffToolPreference[],
    selectedId: string,
    setSelectedId: (id: string) => void,
    onChange: (tools: ExternalDiffToolPreference[]) => void
  ) => {
    const selected = tools.find((tool) => tool.id === selectedId) ?? tools[0]
    const availableIds = new Set(availableExternalToolIds)
    const addTool = (kind: ExternalDiffToolKind) => {
      if (kind === 'none') return
      const base =
        kind === 'custom'
          ? createCustomExternalTool(mode)
          : externalToolPreset(mode, kind as Exclude<ExternalDiffToolKind, 'none' | 'custom'>)
      const tool = {
        ...base,
        id: tools.some((candidate) => candidate.id === base.id) ? `${base.id}-${Date.now()}` : base.id,
        primary: tools.length === 0
      }
      onChange([...tools, tool])
      setSelectedId(tool.id)
    }
    return (
      <fieldset className="settings-group settings-group--external-diff">
        <legend>{t(mode === 'diff' ? 'externalDiffTools' : 'externalMergeTools')}</legend>
        <p className="settings-external-diff__description">
          {t(mode === 'diff' ? 'externalDiffToolDescription' : 'externalMergeToolDescription')}
        </p>
        <div className="settings-external-tools">
          <div className="settings-external-tools__list">
            {tools.map((tool) => (
              <button
                key={tool.id}
                type="button"
                className={selected?.id === tool.id ? 'is-selected' : ''}
                onClick={() => setSelectedId(tool.id)}
              >
                <span>{tool.name || t('unnamedExternalTool')}</span>
                <small>
                  {tool.primary ? `${t('primaryExternalTool')} · ` : ''}
                  {availableIds.has(tool.id) ? t('externalToolAvailable') : t('externalToolUnavailable')}
                </small>
              </button>
            ))}
            <SelectInput
              value=""
              aria-label={t('addExternalTool')}
              onChange={(event) => addTool(event.target.value as ExternalDiffToolKind)}
            >
              <option value="">{t('addExternalTool')}</option>
              <option value="vscode">Visual Studio Code</option>
              <option value="cursor">Cursor</option>
              <option value="beyondCompare">Beyond Compare</option>
              <option value="p4merge">P4Merge</option>
              <option value="meld">Meld</option>
              <option value="custom">{t('customExternalDiffTool')}</option>
            </SelectInput>
          </div>
          {selected && (
            <div className="settings-external-tools__editor">
              <label className="settings-external-diff__field">
                <span>{t('externalDiffToolName')}</span>
                <TextInput
                  value={selected.name}
                  maxLength={128}
                  spellCheck={false}
                  onChange={(event) => updateExternalTools(mode, tools, selected.id, { name: event.target.value })}
                />
              </label>
              <label className="settings-external-diff__field">
                <span>{t('externalDiffExecutable')}</span>
                <span className="settings-external-diff__executable">
                  <TextInput
                    value={selected.executable}
                    maxLength={4096}
                    spellCheck={false}
                    onChange={(event) =>
                      updateExternalTools(mode, tools, selected.id, { executable: event.target.value })
                    }
                  />
                  <TextButton
                    onClick={() =>
                      void onChooseExternalDiffExecutable().then((executable) => {
                        if (executable) updateExternalTools(mode, tools, selected.id, { executable })
                      })
                    }
                  >
                    <FolderOpen size={14} />
                    {t('choose')}
                  </TextButton>
                </span>
                <small>{t('externalToolPathHint')}</small>
              </label>
              <label className="settings-external-diff__field">
                <span>{t('externalDiffArgumentTemplate')}</span>
                <textarea
                  value={selected.arguments.join('\n')}
                  rows={mode === 'diff' ? 5 : 6}
                  spellCheck={false}
                  onChange={(event) =>
                    updateExternalTools(mode, tools, selected.id, {
                      arguments: event.target.value.replaceAll('\r', '').split('\n')
                    })
                  }
                />
                <small>{t(mode === 'diff' ? 'externalDiffPlaceholderHint' : 'externalMergePlaceholderHint')}</small>
              </label>
              <div className="settings-external-tools__actions">
                <TextButton
                  disabled={selected.primary}
                  onClick={() => updateExternalTools(mode, tools, selected.id, { primary: true })}
                >
                  {t('setPrimaryExternalTool')}
                </TextButton>
                <TextButton
                  onClick={() => {
                    const next = tools.filter((tool) => tool.id !== selected.id)
                    if (selected.primary && next[0]) next[0] = { ...next[0], primary: true }
                    onChange(next)
                    setSelectedId(next[0]?.id ?? '')
                  }}
                >
                  {t('removeExternalTool')}
                </TextButton>
              </div>
              {!isExternalToolConfigured(selected, mode) && (
                <div className="settings-external-diff__warning">
                  <AlertTriangle size={14} />
                  <span>{t('externalToolConfigurationIncomplete')}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </fieldset>
    )
  }

  const updateStatus = !updateState
    ? t('updatesOnlyDesktopRelease')
    : updateState.phase === 'unsupported'
      ? t('updatesOnlyDesktopRelease')
      : updateState.phase === 'checking'
        ? t('checkingForUpdates')
        : updateState.phase === 'upToDate'
          ? t('latestVersionInstalled')
          : updateState.phase === 'available'
            ? `${t('applicationUpdateAvailable')} · ${updateState.availableVersion}`
            : updateState.phase === 'error'
              ? updateState.errorKind === 'install'
                ? t('updateInstallFailedDescription')
                : t('updateCheckFailedDescription')
              : t('automaticUpdateCheckDescription')

  /**
   * `role="tablist"` 需要方向键语义。这里同时接受横向和纵向方向键，
   * 使 CSS 在窄窗口把侧栏改为横向分类条后无需同步切换事件逻辑。
   */
  const handleCategoryKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    const currentIndex = tabs.indexOf(event.target as HTMLButtonElement)
    if (currentIndex < 0 || !tabs.length) return

    event.preventDefault()
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : event.key === 'ArrowDown' || event.key === 'ArrowRight'
            ? (currentIndex + 1) % tabs.length
            : (currentIndex - 1 + tabs.length) % tabs.length
    tabs[nextIndex]?.focus()
    tabs[nextIndex]?.click()
  }

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section className="task-dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="task-dialog__header">
          <span className="task-dialog__mark">
            <Settings2 size={18} />
          </span>
          <span>
            <small>CLIENT</small>
            <h2 id="settings-title">{t('clientSettings')}</h2>
          </span>
          <button type="button" aria-label={t('closeSettings')} onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="task-dialog__body settings-dialog__body">
          <nav
            className="settings-categories"
            role="tablist"
            aria-label={t('clientSettingsCategories')}
            aria-orientation="vertical"
            onKeyDown={handleCategoryKeyDown}
          >
            {settingsCategories.map((category) => {
              const CategoryIcon = category.icon
              const isActive = activeCategory === category.id
              return (
                <button
                  id={`settings-tab-${category.id}`}
                  key={category.id}
                  type="button"
                  role="tab"
                  className={isActive ? 'is-active' : ''}
                  aria-controls={`settings-panel-${category.id}`}
                  aria-selected={isActive}
                  tabIndex={isActive ? 0 : -1}
                  onClick={() => setActiveCategory(category.id)}
                >
                  <span className="settings-categories__icon">
                    <CategoryIcon size={15} />
                  </span>
                  <span>
                    <strong>{category.label}</strong>
                    <small>{category.description}</small>
                  </span>
                </button>
              )
            })}
          </nav>

          <div className="settings-content">
            <section
              id="settings-panel-general"
              className="settings-page"
              role="tabpanel"
              aria-labelledby="settings-tab-general"
              hidden={activeCategory !== 'general'}
            >
              <header className="settings-page__header">
                <span>
                  <SlidersHorizontal size={17} />
                </span>
                <div>
                  <h3>{t('clientSettingsGeneral')}</h3>
                  <p>{t('clientSettingsGeneralDescription')}</p>
                </div>
              </header>
              <fieldset className="settings-group">
                <legend>{t('appearance')}</legend>
                <div className="theme-options">
                  {themeOptions.map((option) => {
                    const OptionIcon = option.icon
                    return (
                      <button
                        key={option.id}
                        type="button"
                        className={preference === option.id ? 'is-selected' : ''}
                        aria-pressed={preference === option.id}
                        onClick={() => onPreferenceChange(option.id)}
                      >
                        <OptionIcon size={17} />
                        <span>{option.label}</span>
                      </button>
                    )
                  })}
                </div>
              </fieldset>
              <fieldset className="settings-group settings-group--language">
                <legend>{t('interfaceLanguage')}</legend>
                <div className="theme-options language-options">
                  {languageOptions.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={language === option.id ? 'is-selected' : ''}
                      aria-pressed={language === option.id}
                      onClick={() => onLanguageChange(option.id)}
                    >
                      <Languages size={17} />
                      <span>
                        <strong>{option.label}</strong>
                      </span>
                    </button>
                  ))}
                </div>
              </fieldset>
              <fieldset className="settings-group settings-group--binary-preview">
                <legend>{t('binaryPreview')}</legend>
                <label className="settings-binary-preview-limit">
                  <span>
                    <strong>{t('binaryPreviewLimit')}</strong>
                    <small id="binary-preview-limit-hint">{t('binaryPreviewLimitDescription')}</small>
                  </span>
                  <span className="settings-binary-preview-limit__control">
                    <NumberInput
                      value={binaryPreviewLimitDraft}
                      min={MIN_BINARY_PREVIEW_LIMIT_MIB}
                      step={0.01}
                      inputMode="decimal"
                      aria-label={t('binaryPreviewLimit')}
                      aria-describedby="binary-preview-limit-hint"
                      onChange={(event) => setBinaryPreviewLimitDraft(event.target.value)}
                      onBlur={commitBinaryPreviewLimit}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur()
                      }}
                    />
                    <span aria-hidden="true">MiB</span>
                  </span>
                </label>
              </fieldset>
            </section>

            <section
              id="settings-panel-identity"
              className="settings-page"
              role="tabpanel"
              aria-labelledby="settings-tab-identity"
              hidden={activeCategory !== 'identity'}
            >
              <header className="settings-page__header">
                <span>
                  <UserRound size={17} />
                </span>
                <div>
                  <h3>{t('defaultCommitIdentity')}</h3>
                  <p>{t('clientSettingsIdentityDescription')}</p>
                </div>
              </header>
              <div className="settings-group settings-group--identity">
                <div className="settings-identity-field">
                  {/*
                   * 默认身份邮箱与历史作者遵循同一头像规范。远程头像只覆盖底层缩写；
                   * 邮箱无效、没有 Gravatar、离线或 Web Crypto 不可用时都稳定回退，
                   * 不会隐藏姓名与邮箱，也不会把头像 URL 写入客户端偏好。
                   */}
                  <RevisionAuthorAvatar
                    identity={identity.email}
                    initials={(identity.name || identity.email).trim().slice(0, 1).toLocaleUpperCase()}
                    variant="detail"
                  />
                  <span>
                    <strong>{t('authorAndEmail')}</strong>
                    <small>{t('encodedLoreIdentityUsedRepository_df34')}</small>
                  </span>
                  {defaultIdentity && (
                    <button type="button" onClick={() => updateIdentity('', '')}>
                      {t('clear')}
                    </button>
                  )}
                  <div className="settings-identity-inputs">
                    <label>
                      <span>{t('authorName')}</span>
                      <input
                        value={identity.name}
                        maxLength={240}
                        spellCheck={false}
                        placeholder={t('exampleAuthorName')}
                        aria-label={t('defaultCommitAuthor')}
                        onChange={(event) => updateIdentity(event.target.value, identity.email)}
                      />
                    </label>
                    <label>
                      <span>{t('email')}</span>
                      <input
                        type="email"
                        value={identity.email}
                        maxLength={254}
                        spellCheck={false}
                        placeholder={t('exampleAuthorEmail')}
                        aria-label={t('defaultCommitEmail')}
                        onChange={(event) => updateIdentity(identity.name, event.target.value)}
                      />
                    </label>
                  </div>
                </div>
              </div>
            </section>

            <section
              id="settings-panel-integrations"
              className="settings-page"
              role="tabpanel"
              aria-labelledby="settings-tab-integrations"
              hidden={activeCategory !== 'integrations'}
            >
              <header className="settings-page__header">
                <span>
                  <GitCompareArrows size={17} />
                </span>
                <div>
                  <h3>{t('clientSettingsIntegrations')}</h3>
                  <p>{t('clientSettingsIntegrationsDescription')}</p>
                </div>
              </header>
              {renderExternalToolGroup(
                'merge',
                externalMergeTools,
                selectedMergeToolId,
                setSelectedMergeToolId,
                onExternalMergeToolsChange
              )}
              {renderExternalToolGroup(
                'diff',
                externalDiffTools,
                selectedDiffToolId,
                setSelectedDiffToolId,
                onExternalDiffToolsChange
              )}
            </section>

            <section
              id="settings-panel-storage"
              className="settings-page"
              role="tabpanel"
              aria-labelledby="settings-tab-storage"
              hidden={activeCategory !== 'storage'}
            >
              <header className="settings-page__header">
                <span>
                  <Database size={17} />
                </span>
                <div>
                  <h3>{t('clientSettingsStorage')}</h3>
                  <p>{t('clientSettingsStorageDescription')}</p>
                </div>
              </header>
              <fieldset className="settings-group settings-group--shared-store">
                <legend>{t('sharedStore')}</legend>
                <div className="settings-shared-store__toolbar">
                  <label>
                    <CheckboxInput
                      checked={sharedStoreInfo?.useAutomatically ?? false}
                      disabled={sharedStoreBusy || !sharedStoreInfo}
                      onChange={(event) => onSharedStoreAutomaticChange(event.target.checked)}
                    />
                    <span>
                      <strong>{t('useSharedStoreAutomatically')}</strong>
                      <small>{t('sharedStoreAutomaticDescription')}</small>
                    </span>
                  </label>
                  <button
                    type="button"
                    disabled={sharedStoreLoading || sharedStoreBusy}
                    onClick={onRefreshSharedStores}
                  >
                    <RefreshCw className={sharedStoreLoading ? 'is-spinning' : ''} size={14} />
                    {t('refresh')}
                  </button>
                </div>

                {sharedStoreError && (
                  <div className="settings-shared-store__error">
                    <AlertTriangle size={14} />
                    <span>{sharedStoreError}</span>
                  </div>
                )}

                {/*
                 * 创建参数必须与创建动作保持连续，放在现有 Store 清单之前。
                 * 用户先完成地址和设备目录决策，再查看当前用量与既有 Store，
                 * 不会在输入和提交之间被只读状态信息打断。
                 */}
                <div className="settings-shared-store__create">
                  <label>
                    <span>{t('sharedStoreTargetServer')}</span>
                    <input
                      value={sharedStoreRemoteUrl}
                      spellCheck={false}
                      placeholder="lore://127.0.0.1:41337"
                      onChange={(event) => setSharedStoreRemoteUrl(event.target.value)}
                    />
                    <small>{t('sharedStoreTargetServerHint')}</small>
                  </label>
                  <div className="field-stack">
                    <span>{t('sharedStoreParentDirectoryOptional')}</span>
                    <div className="path-picker">
                      <code title={sharedStoreParent}>{sharedStoreParent || t('useLoreDefaultLocation')}</code>
                      {sharedStoreParent && (
                        <button type="button" disabled={sharedStoreBusy} onClick={() => setSharedStoreParent('')}>
                          {t('clear')}
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={sharedStoreBusy}
                        onClick={() =>
                          void onChooseSharedStoreParent().then((path) => path && setSharedStoreParent(path))
                        }
                      >
                        <FolderOpen size={14} />
                        {t('choose')}
                      </button>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="is-primary"
                    disabled={sharedStoreBusy || !sharedStoreRemoteUrl.trim()}
                    onClick={() => onCreateSharedStore(sharedStoreRemoteUrl.trim(), sharedStoreParent)}
                  >
                    {sharedStoreBusy ? <LoaderCircle className="is-spinning" size={14} /> : <Database size={14} />}
                    {t('createSharedStore')}
                  </button>
                </div>

                <div className="settings-shared-store__summary">
                  <Database size={16} />
                  <span>
                    <strong>
                      {t('status.sharedStoreSummary', {
                        count: sharedStoreInfo?.stores.length ?? 0,
                        size: formatBytes(sharedStoreInfo?.totalSizeBytes ?? 0)
                      })}
                    </strong>
                    <small>{t('sharedStoreExactSavingsUnavailable')}</small>
                  </span>
                </div>

                <div className="settings-shared-store__list">
                  {sharedStoreInfo?.stores.map((store) => (
                    <div className="settings-shared-store__entry" key={`${store.remoteUrl}:${store.path}`}>
                      <span
                        className={store.exists && !store.scanError ? 'is-healthy' : 'is-warning'}
                        aria-hidden="true"
                      />
                      <span>
                        <strong>{store.remoteUrl}</strong>
                        <code title={store.path}>{store.path}</code>
                        <small>
                          {store.exists
                            ? t('status.sharedStoreUsage', {
                                size: formatBytes(store.sizeBytes),
                                count: store.fileCount
                              })
                            : t('sharedStoreMissingOnDisk')}
                        </small>
                        {store.scanError && <small className="is-error">{store.scanError}</small>}
                      </span>
                    </div>
                  ))}
                  {!sharedStoreLoading && !sharedStoreInfo?.stores.length && (
                    <small className="settings-shared-store__empty">{t('noSharedStoresConfigured')}</small>
                  )}
                </div>
              </fieldset>
            </section>

            <section
              id="settings-panel-maintenance"
              className="settings-page"
              role="tabpanel"
              aria-labelledby="settings-tab-maintenance"
              hidden={activeCategory !== 'maintenance'}
            >
              <header className="settings-page__header">
                <span>
                  <Wrench size={17} />
                </span>
                <div>
                  <h3>{t('maintenance')}</h3>
                  <p>{t('clientSettingsMaintenanceDescription')}</p>
                </div>
              </header>
              <div className="settings-row">
                <span>
                  <strong>{t('workspacePanes')}</strong>
                  <small>{t('restoreDefaultSidebarInspectorWidths_875e')}</small>
                </span>
                <button type="button" onClick={onResetLayout}>
                  <RotateCcw size={14} />
                  {t('restoreDefaults')}
                </button>
              </div>
              <fieldset className="settings-group settings-group--logs">
                <legend>{t('applicationLogs')}</legend>
                <div className="settings-log">
                  <span>
                    <strong>{t('logDirectory')}</strong>
                    <small>{t('applicationLogsDescription')}</small>
                    {applicationLogInfo && (
                      <small>
                        {t('status.applicationLogRetention', {
                          size: `${Math.round(applicationLogInfo.maxFileSizeBytes / 1024 / 1024)} MiB`,
                          count: applicationLogInfo.retainedFileCount
                        })}
                      </small>
                    )}
                  </span>
                  <code title={applicationLogInfo?.directoryPath}>
                    {applicationLogLoading
                      ? t('loadingLogDirectory')
                      : applicationLogInfo?.directoryPath || t('logDirectoryUnavailable')}
                  </code>
                  <TextButton
                    disabled={!applicationLogInfo || applicationLogLoading}
                    onClick={() => void openLogDirectory()}
                  >
                    <FolderOpen size={14} />
                    {t('openLogDirectory')}
                  </TextButton>
                </div>
                {applicationLogError && <small className="settings-log__error">{t('unableToOpenLogDirectory')}</small>}
              </fieldset>
              <fieldset className="settings-group settings-group--updates">
                <legend>{t('applicationUpdates')}</legend>
                <label className="settings-update-preference">
                  <span>
                    <strong>{t('automaticallyCheckForUpdates')}</strong>
                    <small>{t('automaticUpdateCheckDescription')}</small>
                  </span>
                  {/* 把复选框放在说明文案之后，使维护页的布尔偏好统一从行尾操作。 */}
                  <CheckboxInput
                    checked={automaticallyCheckForUpdates}
                    onChange={(event) => onAutomaticallyCheckForUpdatesChange(event.target.checked)}
                  />
                </label>
                <div className="settings-update">
                  {/* 当前版本是信息摘要，右侧按钮已经清楚表达检查更新动作，无需重复图标。 */}
                  <span className="settings-update__details">
                    <strong>{t('currentVersion')}</strong>
                    <small>{updateState?.currentVersion || updateStatus}</small>
                    {updateState?.currentVersion && <small>{updateStatus}</small>}
                  </span>
                  {updateState?.phase === 'available' ? (
                    <button type="button" className="is-primary" onClick={onShowUpdate}>
                      {t('downloadInstallAndRestart')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={
                        !updateState ||
                        updateState.phase === 'unsupported' ||
                        isUpdateBusy(updateState.phase) ||
                        !onCheckForUpdates
                      }
                      onClick={onCheckForUpdates}
                    >
                      <RefreshCw size={14} />
                      {updateState?.phase === 'checking' ? t('checkingForUpdates') : t('checkForUpdates')}
                    </button>
                  )}
                </div>
              </fieldset>
            </section>
          </div>
        </div>
      </section>
    </div>
  )
}

/** Shared Store 数字是只读快照，使用紧凑二进制单位即可避免对语言状态产生依赖。 */
function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1_024)), units.length - 1)
  return `${(bytes / 1_024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`
}
