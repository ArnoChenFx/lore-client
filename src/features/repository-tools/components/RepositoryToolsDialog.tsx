import {
  CheckCircle2,
  CloudCog,
  Database,
  FileSearch,
  History,
  Layers3,
  Link2,
  LockKeyhole,
  LockKeyholeOpen,
  LoaderCircle,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Stethoscope,
  Trash2,
  TriangleAlert,
  Upload,
  UserRound,
  X
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  fileLockOwnerLabel,
  formatCommitIdentity,
  isUnidentifiedFileLockOwner,
  parseCommitIdentity
} from '../../../shared/lib'
import { CheckboxInput, SelectInput } from '../../../shared/ui'
import type {
  Branch,
  LoreBranchDiff,
  LoreBranchInfo,
  LoreBranchLatestEntry,
  LoreAuthIdentity,
  LoreLayer,
  LoreFileLock,
  LoreDependencyGraphQuery,
  LoreDependencySelection,
  LoreLayerAddRequest,
  LoreLayerRemoveRequest,
  LoreLink,
  LoreLinkAddRequest,
  LoreLinkUpdateRequest,
  LoreRevisionInfo,
  LoreMetadataEntry,
  LoreMetadataScope,
  LoreDiagnosticReport,
  LoreRepositoryInstance,
  Repository,
  RepositoryView,
  RepositoryViewPreview,
  Revision
} from '../../../types'
import type { RepositoryToolTab, RepositoryToolsDialogProps } from '../types'
import { AuthAccountsPanel, authIdentityKey, consolidateAuthIdentities } from './AuthAccountsPanel'
import { BranchCollaborationPanel } from './BranchCollaborationPanel'
import { DependencyGraphPanel } from './DependencyGraphPanel'
import { MetadataBrowserPanel } from './MetadataBrowserPanel'
import { RepositoryDiagnosticsPanel } from './RepositoryDiagnosticsPanel'
import { RevisionRecoveryPanel } from './RevisionRecoveryPanel'

/** 展示 Lore Core 的真实 Layer、Link 和仓库维护操作。 */
export function RepositoryToolsDialog({
  tab,
  repository,
  branches = [],
  revisions = [],
  defaultIdentity,
  layers,
  links,
  locks = [],
  dependencyQuery = null,
  loading,
  compositionAvailable,
  lockAvailable = false,
  dependencyAvailable = false,
  publishAvailable,
  connectedRemoteDescription = '',
  connectedRemoteName = '',
  publishAuthIdentities = [],
  repositoryView,
  currentRevisionId,
  viewBlockedReason,
  onTabChange,
  onRefresh,
  onSaveConfiguration,
  onPublish,
  onPushCurrentBranch,
  onPreviewView,
  onApplyView,
  onAddLayer,
  onRemoveLayer,
  onAddLink,
  onUpdateLink,
  onRemoveLink,
  onAcquireLock = async () => false,
  onReleaseLock = async () => false,
  onQueryDependencies = async () => null,
  onAddDependency = async () => false,
  onRemoveDependency = async () => false,
  onDependencySync = async () => false,
  onLoadBranchCollaboration = async () => {
    throw new Error('Branch collaboration is unavailable')
  },
  onLoadBranchDiff = async () => {
    throw new Error('Branch diff is unavailable')
  },
  onSetBranchProtected = async () => false,
  onResetBranchLatest = async () => false,
  onLoadRevisionInfo = async () => {
    throw new Error('Revision information is unavailable')
  },
  onFindRevisionNumber = async () => '',
  onFindRevisionMetadata = async () => '',
  onAmendRevision = async () => false,
  onBisectRevision = async () => false,
  onRestoreRevision = async () => false,
  onLocateRevision = () => undefined,
  onListAuthIdentities = async () => [],
  authStateVersion = 0,
  accountRepositories = [],
  authAccountBindings = [],
  onSetAuthAccountBinding = async () => false,
  onLoginAuthInteractive = async () => false,
  onLoginAuthWithToken = async () => false,
  onLogoutAuthIdentity = async () => false,
  onClearAuthIdentities = async () => false,
  onLoadMetadata = async () => [],
  onVerifyPath = async () => {
    throw new Error('Repository verification is unavailable')
  },
  onVerifyFragment = async () => {
    throw new Error('Fragment verification is unavailable')
  },
  onDumpRepository = async () => {
    throw new Error('Repository dump is unavailable')
  },
  onListInstances = async () => [],
  onPruneInstances = async () => false,
  onUpdateInstancePath = async () => false,
  onVerify,
  onCollectGarbage,
  onClose
}: RepositoryToolsDialogProps) {
  const { t } = useTranslation()
  const initialIdentity = parseCommitIdentity(repository.identity ?? '')
  const [identityName, setIdentityName] = useState(initialIdentity.name)
  const [identityEmail, setIdentityEmail] = useState(initialIdentity.email)
  const [remoteUrl, setRemoteUrl] = useState(repository.remoteUrl ?? '')
  const [remoteRepositoryName, setRemoteRepositoryName] = useState(connectedRemoteName || repository.name)
  const [remoteRepositoryNameDirty, setRemoteRepositoryNameDirty] = useState(false)
  const [remoteDescription, setRemoteDescription] = useState(connectedRemoteDescription)
  const [remoteDescriptionDirty, setRemoteDescriptionDirty] = useState(false)
  /*
   * Auth List 会为同一账户返回根身份和多个资源授权条目。发布下拉先按完整账户合并，
   * 再按 Rust 当前可接受的 userId 去重，避免渲染多个最终传递同一值的选项。
   */
  const publishAccounts = useMemo(
    () => [
      ...new Map(
        consolidateAuthIdentities(publishAuthIdentities).map((account) => [account.userId.trim(), account] as const)
      ).values()
    ],
    [publishAuthIdentities]
  )
  const boundPublishAccount = useMemo(
    () =>
      authAccountBindings.find(
        (binding) =>
          binding.repositoryPath
            .trim()
            .replace(/[\\/]+$/, '')
            .toLocaleLowerCase() ===
          repository.path
            .trim()
            .replace(/[\\/]+$/, '')
            .toLocaleLowerCase()
      ),
    [authAccountBindings, repository.path]
  )
  const [publishAuthUserId, setPublishAuthUserId] = useState(boundPublishAccount?.userId ?? '')
  const [viewDraft, setViewDraft] = useState(repositoryView?.content ?? '')
  const [viewPreview, setViewPreview] = useState<RepositoryViewPreview | null>(null)
  const [previewedViewContent, setPreviewedViewContent] = useState<string | null>(null)
  const [viewPending, setViewPending] = useState(false)
  const [viewError, setViewError] = useState('')
  const [resourcePending, setResourcePending] = useState(false)
  const [layerEditorOpen, setLayerEditorOpen] = useState(false)
  const [layerTargetPath, setLayerTargetPath] = useState('')
  const [layerSourceRepository, setLayerSourceRepository] = useState('')
  const [layerSourcePath, setLayerSourcePath] = useState('/')
  const [layerMetadata, setLayerMetadata] = useState('')
  const [layerRemoval, setLayerRemoval] = useState<LoreLayer | null>(null)
  const [layerPurge, setLayerPurge] = useState(false)
  const [linkEditorOpen, setLinkEditorOpen] = useState(false)
  const [linkRepositoryUrl, setLinkRepositoryUrl] = useState('')
  const [linkPath, setLinkPath] = useState('')
  const [linkSourcePath, setLinkSourcePath] = useState('/')
  const [linkPin, setLinkPin] = useState('')
  const [linkDisableBranching, setLinkDisableBranching] = useState(false)
  const [editingLink, setEditingLink] = useState<LoreLink | null>(null)
  const [editingLinkPin, setEditingLinkPin] = useState('')
  const [lockPath, setLockPath] = useState('')
  const [lockFilter, setLockFilter] = useState('')
  const identity = formatCommitIdentity(identityName, identityEmail)
  const defaultIdentityParts = useMemo(() => parseCommitIdentity(defaultIdentity), [defaultIdentity])

  /*
   * 保存成功后 App 会重读仓库快照；这里只在快照字段或仓库路径真正变化时
   * 重新初始化草稿，避免用户输入过程中普通父组件渲染覆盖尚未保存的内容。
   */
  useEffect(() => {
    const nextIdentity = parseCommitIdentity(repository.identity ?? '')
    setIdentityName(nextIdentity.name)
    setIdentityEmail(nextIdentity.email)
    setRemoteUrl(repository.remoteUrl ?? '')
  }, [repository.identity, repository.path, repository.remoteUrl])

  useEffect(() => {
    setRemoteRepositoryName(repository.name)
    setRemoteRepositoryNameDirty(false)
    setRemoteDescription('')
    setRemoteDescriptionDirty(false)
  }, [repository.name, repository.path])

  useEffect(() => {
    /*
     * 服务器按 Repository ID 找到的名称是部分成功发布后的权威值。用户尚未编辑时
     * 自动回填，避免再次用不同名称触发 Lore 的 ID 唯一性错误。
     */
    if (connectedRemoteName && !remoteRepositoryNameDirty) {
      setRemoteRepositoryName(connectedRemoteName)
    }
  }, [connectedRemoteName, remoteRepositoryNameDirty])

  useEffect(() => {
    /*
     * 仓库已有绑定时默认显示该账户；没有绑定时保持显式空值，让公开服务器发布
     * 不会因为设备上恰好登录了一个账户而悄悄切换为认证请求。
     */
    setPublishAuthUserId(boundPublishAccount?.userId ?? '')
  }, [boundPublishAccount?.userId, repository.path])

  useEffect(() => {
    /*
     * 远端详情在弹层打开后异步返回。只在用户尚未编辑时写入真实说明，避免慢请求
     * 覆盖已经键入的发布文案。
     */
    if (!remoteDescriptionDirty) {
      setRemoteDescription(connectedRemoteDescription)
    }
  }, [connectedRemoteDescription, remoteDescriptionDirty])

  useEffect(() => {
    setViewDraft(repositoryView?.content ?? '')
    setViewPreview(null)
    setPreviewedViewContent(null)
    setViewError('')
  }, [repository.path, repositoryView?.content])

  useEffect(() => {
    /*
     * 组合仓库表单只能属于当前 Repository。切换项目标签时清空所有草稿和危险
     * 选择，防止把上一仓库的挂载路径误提交到新仓库。
     */
    setResourcePending(false)
    setLayerEditorOpen(false)
    setLayerTargetPath('')
    setLayerSourceRepository('')
    setLayerSourcePath('/')
    setLayerMetadata('')
    setLayerRemoval(null)
    setLayerPurge(false)
    setLinkEditorOpen(false)
    setLinkRepositoryUrl('')
    setLinkPath('')
    setLinkSourcePath('/')
    setLinkPin('')
    setLinkDisableBranching(false)
    setEditingLink(null)
    setEditingLinkPin('')
    setLockPath('')
    setLockFilter('')
  }, [repository.path])

  const configurationDirty = useMemo(
    () =>
      identity.trim() !== (repository.identity ?? '').trim() ||
      remoteUrl.trim().replace(/\/+$/, '') !== (repository.remoteUrl ?? '').trim().replace(/\/+$/, ''),
    [identity, remoteUrl, repository.identity, repository.remoteUrl]
  )
  const viewDirty = viewDraft !== (repositoryView?.content ?? '')
  const previewIsCurrent = previewedViewContent === viewDraft && viewPreview !== null
  const effectiveViewDiagnostics = previewIsCurrent
    ? viewPreview.diagnostics
    : viewDirty
      ? []
      : (repositoryView?.diagnostics ?? [])
  const dialogBusy = loading || viewPending || resourcePending

  const previewView = async () => {
    if (!currentRevisionId) return
    setViewPending(true)
    setViewError('')
    try {
      const preview = await onPreviewView(viewDraft)
      setViewPreview(preview)
      setPreviewedViewContent(viewDraft)
    } catch (error) {
      setViewError(error instanceof Error ? error.message : t('repositoryViewPreviewFailed'))
    } finally {
      setViewPending(false)
    }
  }

  const applyView = async () => {
    if (!previewIsCurrent || !viewPreview?.valid || viewBlockedReason) return
    if (
      !window.confirm(
        t('confirm.applyRepositoryView', {
          materialize: viewPreview.materializeFiles,
          dematerialize: viewPreview.dematerializeFiles
        })
      )
    ) {
      return
    }
    setViewPending(true)
    setViewError('')
    try {
      if (await onApplyView(viewDraft)) {
        setViewPreview(null)
        setPreviewedViewContent(null)
      }
    } catch (error) {
      setViewError(error instanceof Error ? error.message : t('repositoryViewApplyFailed'))
    } finally {
      setViewPending(false)
    }
  }

  const submitLayer = async () => {
    setResourcePending(true)
    try {
      const succeeded = await onAddLayer({
        targetPath: layerTargetPath,
        sourceRepository: layerSourceRepository,
        sourcePath: layerSourcePath,
        metadata: layerMetadata
      })
      if (succeeded) {
        setLayerEditorOpen(false)
        setLayerTargetPath('')
        setLayerSourceRepository('')
        setLayerSourcePath('/')
        setLayerMetadata('')
      }
    } finally {
      setResourcePending(false)
    }
  }

  const submitLayerRemoval = async () => {
    if (!layerRemoval) return
    const confirmed = window.confirm(
      t(layerPurge ? 'confirm.purgeLayer' : 'confirm.removeLayer', {
        repository: repository.name,
        path: layerRemoval.targetPath,
        source: layerRemoval.sourceRepository
      })
    )
    if (!confirmed) return

    setResourcePending(true)
    try {
      if (
        await onRemoveLayer({
          targetPath: layerRemoval.targetPath,
          sourceRepository: layerRemoval.sourceRepository,
          purge: layerPurge
        })
      ) {
        setLayerRemoval(null)
        setLayerPurge(false)
      }
    } finally {
      setResourcePending(false)
    }
  }

  const submitLink = async () => {
    setResourcePending(true)
    try {
      const succeeded = await onAddLink({
        repositoryUrl: linkRepositoryUrl,
        linkPath,
        sourcePath: linkSourcePath,
        pin: linkPin,
        disableBranching: linkDisableBranching
      })
      if (succeeded) {
        setLinkEditorOpen(false)
        setLinkRepositoryUrl('')
        setLinkPath('')
        setLinkSourcePath('/')
        setLinkPin('')
        setLinkDisableBranching(false)
      }
    } finally {
      setResourcePending(false)
    }
  }

  const submitLinkUpdate = async () => {
    if (!editingLink) return
    const confirmed = window.confirm(
      t('confirm.updateLinkPin', {
        repository: repository.name,
        path: editingLink.linkPath,
        pin: editingLinkPin.trim() || t('loreDefaultPin')
      })
    )
    if (!confirmed) return

    setResourcePending(true)
    try {
      if (
        await onUpdateLink({
          linkPath: editingLink.linkPath,
          pin: editingLinkPin
        })
      ) {
        setEditingLink(null)
        setEditingLinkPin('')
      }
    } finally {
      setResourcePending(false)
    }
  }

  const submitLinkRemoval = async (link: LoreLink) => {
    if (
      !window.confirm(
        t('confirm.removeLink', {
          repository: repository.name,
          path: link.linkPath
        })
      )
    ) {
      return
    }

    setResourcePending(true)
    try {
      await onRemoveLink(link.linkPath)
    } finally {
      setResourcePending(false)
    }
  }

  const submitLockAcquire = async () => {
    const path = lockPath.trim()
    if (!path) return
    setResourcePending(true)
    try {
      if (await onAcquireLock(path)) {
        setLockPath('')
      }
    } finally {
      setResourcePending(false)
    }
  }

  const submitLockRelease = async (path: string) => {
    if (!window.confirm(t('confirm.releaseCollaborativeLock', { path }))) return
    setResourcePending(true)
    try {
      await onReleaseLock(path)
    } finally {
      setResourcePending(false)
    }
  }

  const visibleLocks = locks.filter((lock) => {
    const filter = lockFilter.trim().toLocaleLowerCase()
    return (
      !filter || `${lock.path} ${lock.owner} ${fileLockOwnerLabel(lock.owner)}`.toLocaleLowerCase().includes(filter)
    )
  })
  const unidentifiedLockCount = locks.filter((lock) => isUnidentifiedFileLockOwner(lock.owner)).length
  const toolTabs: Array<{
    id: RepositoryToolTab
    label: string
    icon: React.ReactNode
  }> = [
    {
      id: 'configuration',
      label: t('configuration'),
      icon: <Settings2 size={15} />
    },
    {
      id: 'view',
      label: t('selectiveSyncView'),
      icon: <SlidersHorizontal size={15} />
    },
    { id: 'layers', label: t('layers'), icon: <Layers3 size={15} /> },
    { id: 'links', label: t('links'), icon: <Link2 size={15} /> },
    {
      id: 'dependencies',
      label: t('dependencies'),
      icon: <Network size={15} />
    },
    {
      id: 'locks',
      label: t('collaborativeLocks'),
      icon: <LockKeyhole size={15} />
    },
    {
      id: 'collaboration',
      label: t('branchCollaboration'),
      icon: <CloudCog size={15} />
    },
    {
      id: 'revision',
      label: t('revisionRecovery'),
      icon: <History size={15} />
    },
    { id: 'accounts', label: t('accounts'), icon: <UserRound size={15} /> },
    { id: 'metadata', label: t('metadata'), icon: <Database size={15} /> },
    {
      id: 'diagnostics',
      label: t('advancedDiagnostics'),
      icon: <Stethoscope size={15} />
    },
    {
      id: 'maintenance',
      label: t('maintenance'),
      icon: <ShieldCheck size={15} />
    }
  ]
  const tabButtonRefs = useRef<Array<HTMLButtonElement | null>>([])
  const canRefresh =
    tab !== 'maintenance' &&
    tab !== 'configuration' &&
    tab !== 'view' &&
    tab !== 'dependencies' &&
    tab !== 'collaboration' &&
    tab !== 'revision' &&
    tab !== 'accounts' &&
    tab !== 'metadata' &&
    tab !== 'diagnostics'

  /**
   * 竖向 Tab 使用桌面工具常见的方向键语义。焦点与选中态同步移动，
   * Home/End 可快速抵达首尾，避免入口增加后只能反复按 Tab 穿过整组导航。
   */
  const moveTabFocus = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null
    if (event.key === 'ArrowDown') nextIndex = (index + 1) % toolTabs.length
    if (event.key === 'ArrowUp') nextIndex = (index - 1 + toolTabs.length) % toolTabs.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = toolTabs.length - 1
    if (nextIndex === null) return

    event.preventDefault()
    onTabChange(toolTabs[nextIndex].id)
    tabButtonRefs.current[nextIndex]?.focus()
  }

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !dialogBusy) onClose()
      }}
    >
      <section className="task-dialog tools-dialog" role="dialog" aria-modal="true" aria-labelledby="tools-title">
        <header className="task-dialog__header">
          <span className="task-dialog__mark">
            <Database size={18} />
          </span>
          <span>
            <small>LORE REPOSITORY</small>
            <h2 id="tools-title">{t('repositoryTools')}</h2>
          </span>
          <button type="button" aria-label={t('closeRepositoryTools')} disabled={dialogBusy} onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="tools-dialog__workspace">
          <nav
            className="tools-dialog__nav"
            role="tablist"
            aria-label={t('repositoryToolCategories')}
            aria-orientation="vertical"
          >
            <div className="tools-dialog__nav-list">
              {toolTabs.map((item, index) => (
                <button
                  key={item.id}
                  ref={(element) => {
                    tabButtonRefs.current[index] = element
                  }}
                  id={`repository-tool-tab-${item.id}`}
                  type="button"
                  role="tab"
                  aria-controls="repository-tool-panel"
                  aria-selected={tab === item.id}
                  tabIndex={tab === item.id ? 0 : -1}
                  className={tab === item.id ? 'is-active' : ''}
                  onClick={() => onTabChange(item.id)}
                  onKeyDown={(event) => moveTabFocus(event, index)}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
            {canRefresh && (
              <footer className="tools-dialog__nav-footer">
                <button type="button" onClick={onRefresh} disabled={loading}>
                  {loading ? <LoaderCircle className="is-spinning" size={14} /> : <RefreshCw size={14} />}
                  <span>{t('refresh')}</span>
                </button>
              </footer>
            )}
          </nav>
          <div
            id="repository-tool-panel"
            className="task-dialog__body tools-dialog__body"
            role="tabpanel"
            aria-labelledby={`repository-tool-tab-${tab}`}
          >
            {tab === 'configuration' && (
              <form
                className="repository-configuration"
                onSubmit={(event) => {
                  event.preventDefault()
                  onSaveConfiguration(identity, remoteUrl)
                }}
              >
                <header>
                  <strong>{repository.name}</strong>
                  <small title={repository.path}>{repository.path}</small>
                </header>
                {/* 配置参数和保存操作共享一个边界，避免保存按钮被误解为发布流程的一部分。 */}
                <section className="repository-configuration__settings">
                  <section className="repository-identity-editor">
                    <header>
                      <span className="repository-configuration__icon">
                        <UserRound size={16} />
                      </span>
                      <span>
                        <strong>{t('repositoryCommitIdentity')}</strong>
                        <small>{t('authorNameEmailEncodedSingle_9817')}</small>
                      </span>
                    </header>
                    <div>
                      <label>
                        <span>{t('authorName')}</span>
                        <input
                          value={identityName}
                          maxLength={240}
                          spellCheck={false}
                          placeholder={defaultIdentityParts.name || t('exampleAuthorName')}
                          aria-label={t('repositoryCommitAuthor')}
                          onChange={(event) => setIdentityName(event.target.value.replace(/[\r\n]/g, ''))}
                        />
                      </label>
                      <label>
                        <span>{t('email')}</span>
                        <input
                          type="email"
                          value={identityEmail}
                          maxLength={254}
                          spellCheck={false}
                          placeholder={defaultIdentityParts.email || t('exampleAuthorEmail')}
                          aria-label={t('repositoryCommitEmail')}
                          onChange={(event) => setIdentityEmail(event.target.value.replace(/[\r\n]/g, ''))}
                        />
                      </label>
                    </div>
                  </section>
                  <div className="repository-configuration__resolution">
                    <span>{t('active')}</span>
                    <strong>
                      {identity.trim()
                        ? t('status.nameRepositorySuffix', {
                            name: identity.trim()
                          })
                        : defaultIdentity.trim()
                          ? t('status.nameClientDefaultSuffix', {
                              name: defaultIdentity.trim()
                            })
                          : t('notConfiguredCannotCreateARevision')}
                    </strong>
                  </div>
                  <label>
                    <span className="repository-configuration__icon">
                      <CloudCog size={16} />
                    </span>
                    <span>
                      <strong>{t('loreServerAddress')}</strong>
                      <small>{t('writesRemoteUrlEnterServer_b01a')}</small>
                    </span>
                    <input
                      value={remoteUrl}
                      maxLength={4096}
                      spellCheck={false}
                      placeholder="lore://host:41337"
                      aria-label={t('loreServerRootAddress')}
                      onChange={(event) => setRemoteUrl(event.target.value.replace(/\s/g, ''))}
                    />
                  </label>
                  <footer>
                    <small>{t('twoFieldsAboveModifiedOther_072f')}</small>
                    <button type="submit" className="is-primary" disabled={loading || !configurationDirty}>
                      {loading ? <LoaderCircle className="is-spinning" size={14} /> : <Save size={14} />}
                      {t('saveRepositoryConfiguration')}
                    </button>
                  </footer>
                </section>
                <section className="repository-publish" aria-labelledby="repository-publish-title">
                  <header>
                    <span>
                      <Upload size={16} />
                    </span>
                    <span>
                      <strong id="repository-publish-title">{t('publishLocalRepository')}</strong>
                      {/* 整句模板便于 i18n 动态规则保留分支名并翻译外围语义。 */}
                      <small>
                        {t('status.publishSameIdHint', {
                          branch: repository.branch
                        })}
                      </small>
                    </span>
                  </header>
                  <label className="repository-publish__field">
                    <span>{t('remoteRepositoryName')}</span>
                    <input
                      value={remoteRepositoryName}
                      maxLength={1000}
                      pattern="[A-Za-z0-9._-]+"
                      title={t('asciiLettersNumbersHyphensUnderscores_88f6')}
                      spellCheck={false}
                      onChange={(event) => {
                        setRemoteRepositoryNameDirty(true)
                        setRemoteRepositoryName(event.target.value)
                      }}
                    />
                  </label>
                  <label className="repository-publish__field">
                    <span>{t('remoteDescriptionOptional')}</span>
                    <textarea
                      value={remoteDescription}
                      maxLength={4096}
                      rows={2}
                      onChange={(event) => {
                        setRemoteDescriptionDirty(true)
                        setRemoteDescription(event.target.value)
                      }}
                    />
                  </label>
                  <div className="repository-publish__connection">
                    <label className="repository-publish__field">
                      <span>{t('publishAccountOptional')}</span>
                      <SelectInput
                        value={publishAuthUserId}
                        disabled={loading}
                        aria-label={t('publishAccountOptional')}
                        onChange={(event) => setPublishAuthUserId(event.currentTarget.value)}
                      >
                        <option value="">{t('publishWithoutAccount')}</option>
                        {boundPublishAccount &&
                          !publishAccounts.some((account) => account.userId === boundPublishAccount.userId) && (
                            <option value={boundPublishAccount.userId} disabled>
                              {boundPublishAccount.userId} · {t('accountUnavailable')}
                            </option>
                          )}
                        {publishAccounts.map((account) => (
                          <option key={authIdentityKey(account)} value={account.userId}>
                            {account.displayName || account.userId} · {account.authUrl}
                          </option>
                        ))}
                      </SelectInput>
                    </label>
                    <div className="repository-publish__target">
                      <span>{t('publishTarget')}</span>
                      <code>
                        {remoteUrl.trim().replace(/\/+$/, '') || t('serverNotConfigured')}/
                        {remoteRepositoryName.trim() || t('untitled')}
                      </code>
                    </div>
                  </div>
                  <footer>
                    <small>{t('committedContentPublishedUncommittedWorkspace_9d51')}</small>
                    <span>
                      <button
                        type="button"
                        onClick={onPushCurrentBranch}
                        disabled={loading || configurationDirty || !repository.remoteUrl?.trim() || !publishAvailable}
                        title={
                          configurationDirty
                            ? t('saveTheRepositoryConfigurationFirst')
                            : repository.remoteUrl
                              ? t('pushCurrentBranchConfiguredRemote_d077')
                              : t('configureSaveServerAddressFirst_6e70')
                        }
                      >
                        <Upload size={14} />
                        {t('pushCurrentBranch')}
                      </button>
                      <button
                        type="button"
                        className="is-primary"
                        onClick={() =>
                          onPublish(
                            identity,
                            remoteUrl,
                            remoteRepositoryName,
                            remoteDescription,
                            publishAuthUserId || undefined
                          )
                        }
                        disabled={loading || !publishAvailable || !remoteUrl.trim() || !remoteRepositoryName.trim()}
                      >
                        {loading ? <LoaderCircle className="is-spinning" size={14} /> : <CloudCog size={14} />}
                        {t('createRemoteAndPush')}
                      </button>
                    </span>
                  </footer>
                </section>
              </form>
            )}
            {tab === 'view' && (
              <form
                className="repository-view-editor"
                onSubmit={(event) => {
                  event.preventDefault()
                  void previewView()
                }}
              >
                <header>
                  <span className="repository-configuration__icon">
                    <SlidersHorizontal size={16} />
                  </span>
                  <span>
                    <strong>{t('selectiveSyncView')}</strong>
                    <small>{t('repositoryViewLocalInstanceHint')}</small>
                  </span>
                  <code>{repositoryView?.path ?? '.lore/view'}</code>
                </header>
                <div className="repository-view-editor__help">
                  <strong>{t('repositoryViewRuleHelpTitle')}</strong>
                  <span>{t('repositoryViewRuleHelp')}</span>
                </div>
                <label>
                  <span>{t('repositoryViewRules')}</span>
                  <textarea
                    value={viewDraft}
                    rows={12}
                    maxLength={256 * 1024}
                    spellCheck={false}
                    placeholder={'# Exclude everything\n**\n# Include one subtree\n!Content/Maps/'}
                    aria-label={t('repositoryViewRules')}
                    onChange={(event) => {
                      setViewDraft(event.target.value)
                      setViewError('')
                    }}
                  />
                </label>
                {effectiveViewDiagnostics.length > 0 && (
                  <ul className="repository-view-editor__diagnostics">
                    {effectiveViewDiagnostics.map((diagnostic) => (
                      <li key={`${diagnostic.code}:${diagnostic.line}`} className={`is-${diagnostic.severity}`}>
                        <span>
                          {diagnostic.line > 0 ? t('status.lineNumber', { line: diagnostic.line }) : t('view')}
                        </span>
                        <strong>{t(diagnostic.code)}</strong>
                      </li>
                    ))}
                  </ul>
                )}
                {viewError && (
                  <p className="repository-view-editor__error" role="alert">
                    {viewError}
                  </p>
                )}
                {previewIsCurrent && viewPreview && (
                  <section className="repository-view-preview" aria-label={t('repositoryViewImpactPreview')}>
                    <header>
                      <span>
                        <FileSearch size={15} />
                        <strong>{t('repositoryViewImpactPreview')}</strong>
                      </span>
                      <small>
                        {t('status.revisionShortLabel', {
                          id: viewPreview.revision.slice(0, 8)
                        })}
                      </small>
                    </header>
                    <div className="repository-view-preview__summary">
                      <span>
                        <strong>{viewPreview.includedFiles}</strong>
                        <small>{t('includedFiles')}</small>
                      </span>
                      <span>
                        <strong>+{viewPreview.materializeFiles}</strong>
                        <small>{t('filesToMaterialize')}</small>
                      </span>
                      <span>
                        <strong>-{viewPreview.dematerializeFiles}</strong>
                        <small>{t('filesToDematerialize')}</small>
                      </span>
                      <span>
                        <strong>{formatViewBytes(viewPreview.includedBytes)}</strong>
                        <small>{t('estimatedMaterializedSize')}</small>
                      </span>
                    </div>
                    {viewPreview.impactFiles.length > 0 ? (
                      <ul className="repository-view-preview__files">
                        {viewPreview.impactFiles.map((file) => (
                          <li key={`${file.action}:${file.path}`}>
                            <span className={`is-${file.action}`}>
                              {file.action === 'materialize' ? t('materialize') : t('dematerialize')}
                            </span>
                            <code>{file.path}</code>
                            <small>{formatViewBytes(file.size)}</small>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="repository-view-preview__empty">{t('repositoryViewNoMaterializationChanges')}</p>
                    )}
                  </section>
                )}
                <footer>
                  <small>
                    {viewBlockedReason ||
                      (viewDirty
                        ? previewIsCurrent
                          ? t('repositoryViewPreviewCurrent')
                          : t('repositoryViewPreviewRequired')
                        : t('repositoryViewNoUnsavedChanges'))}
                  </small>
                  <span>
                    <button type="submit" disabled={dialogBusy || !currentRevisionId}>
                      {viewPending ? <LoaderCircle className="is-spinning" size={14} /> : <FileSearch size={14} />}
                      {t('previewImpact')}
                    </button>
                    <button
                      type="button"
                      className="is-primary"
                      disabled={
                        dialogBusy ||
                        !viewDirty ||
                        !previewIsCurrent ||
                        !viewPreview?.valid ||
                        Boolean(viewBlockedReason)
                      }
                      onClick={() => void applyView()}
                    >
                      {viewPending ? <LoaderCircle className="is-spinning" size={14} /> : <Save size={14} />}
                      {t('applyView')}
                    </button>
                  </span>
                </footer>
              </form>
            )}
            {tab === 'layers' && (
              <div className="composition-manager">
                <header className="composition-manager__header">
                  <span className="composition-manager__icon">
                    <Layers3 size={17} />
                  </span>
                  <span>
                    <strong>{t('layers')}</strong>
                    <small>{t('layerLocalInstanceDescription')}</small>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setLayerEditorOpen((open) => !open)
                      setLayerRemoval(null)
                      setLayerPurge(false)
                    }}
                    disabled={dialogBusy || !compositionAvailable}
                    title={!compositionAvailable ? t('startDesktopAppManageLayersLinks') : undefined}
                  >
                    <Plus size={14} />
                    {t('addLayer')}
                  </button>
                </header>

                {layerEditorOpen && (
                  <form
                    className="composition-form"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void submitLayer()
                    }}
                  >
                    <div className="composition-form__grid">
                      <label>
                        <span>{t('layerMountPath')}</span>
                        <input
                          required
                          value={layerTargetPath}
                          maxLength={4096}
                          spellCheck={false}
                          placeholder="Content/Shared"
                          onChange={(event) => setLayerTargetPath(event.target.value.replace(/[\r\n]/g, ''))}
                        />
                      </label>
                      <label>
                        <span>{t('layerSourceRepository')}</span>
                        <input
                          required
                          value={layerSourceRepository}
                          maxLength={4096}
                          spellCheck={false}
                          placeholder="repository-id"
                          onChange={(event) => setLayerSourceRepository(event.target.value.replace(/[\r\n]/g, ''))}
                        />
                      </label>
                      <label>
                        <span>{t('layerSourcePath')}</span>
                        <input
                          required
                          value={layerSourcePath}
                          maxLength={4096}
                          spellCheck={false}
                          placeholder="/"
                          onChange={(event) => setLayerSourcePath(event.target.value.replace(/[\r\n]/g, ''))}
                        />
                      </label>
                      <label>
                        <span>{t('layerMetadataOptional')}</span>
                        <input
                          value={layerMetadata}
                          maxLength={4096}
                          spellCheck={false}
                          placeholder="release"
                          onChange={(event) => setLayerMetadata(event.target.value.replace(/[\r\n]/g, ''))}
                        />
                      </label>
                    </div>
                    <footer>
                      <button type="button" onClick={() => setLayerEditorOpen(false)} disabled={dialogBusy}>
                        {t('cancel')}
                      </button>
                      <button type="submit" className="is-primary" disabled={dialogBusy}>
                        {resourcePending ? <LoaderCircle className="is-spinning" size={14} /> : <Plus size={14} />}
                        {t('createLayer')}
                      </button>
                    </footer>
                  </form>
                )}

                {layerRemoval && (
                  <section className={`composition-removal${layerPurge ? ' is-danger' : ''}`}>
                    <span>
                      <TriangleAlert size={16} />
                    </span>
                    <div>
                      <strong>
                        {layerRemoval.targetPath} · {layerRemoval.sourceRepository}
                      </strong>
                      <label>
                        <CheckboxInput checked={layerPurge} onChange={(event) => setLayerPurge(event.target.checked)} />
                        <span>{t('purgeLayerFiles')}</span>
                      </label>
                      <small>{layerPurge ? t('purgeLayerFilesHint') : t('keepUntrackedLayerFiles')}</small>
                    </div>
                    <span>
                      <button
                        type="button"
                        onClick={() => {
                          setLayerRemoval(null)
                          setLayerPurge(false)
                        }}
                        disabled={dialogBusy || !compositionAvailable}
                      >
                        {t('cancel')}
                      </button>
                      <button
                        type="button"
                        className={layerPurge ? 'is-danger' : ''}
                        onClick={() => void submitLayerRemoval()}
                        disabled={dialogBusy}
                      >
                        {resourcePending ? <LoaderCircle className="is-spinning" size={14} /> : <Trash2 size={14} />}
                        {t('removeLayer')}
                      </button>
                    </span>
                  </section>
                )}

                <CompositionResourceList
                  empty={t('thisRepositoryHasNoLayers')}
                  icon={<Layers3 size={17} />}
                  items={layers.map((layer) => ({
                    id: layer.id,
                    title: layer.targetPath,
                    detail: `${layer.sourceRepository}:${layer.sourcePath}`,
                    meta: layer.revision,
                    stagedFileCount: layer.stagedFileCount,
                    badges: layer.metadata && layer.metadata !== '—' ? [layer.metadata] : [],
                    actions: (
                      <button
                        type="button"
                        onClick={() => {
                          setLayerRemoval(layer)
                          setLayerPurge(false)
                          setLayerEditorOpen(false)
                        }}
                        disabled={dialogBusy}
                      >
                        <Trash2 size={13} />
                        {t('removeLayer')}
                      </button>
                    )
                  }))}
                />
              </div>
            )}
            {tab === 'links' && (
              <div className="composition-manager">
                <header className="composition-manager__header">
                  <span className="composition-manager__icon">
                    <Link2 size={17} />
                  </span>
                  <span>
                    <strong>{t('links')}</strong>
                    <small>{t('linkVersionedDescription')}</small>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setLinkEditorOpen((open) => !open)
                      setEditingLink(null)
                      setEditingLinkPin('')
                    }}
                    disabled={dialogBusy || !compositionAvailable}
                    title={!compositionAvailable ? t('startDesktopAppManageLayersLinks') : undefined}
                  >
                    <Plus size={14} />
                    {t('addLink')}
                  </button>
                </header>

                {linkEditorOpen && (
                  <form
                    className="composition-form"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void submitLink()
                    }}
                  >
                    <div className="composition-form__grid">
                      <label className="is-wide">
                        <span>{t('linkRepositoryUrl')}</span>
                        <input
                          required
                          value={linkRepositoryUrl}
                          maxLength={4096}
                          spellCheck={false}
                          placeholder="lore://host:41337/repository"
                          onChange={(event) => setLinkRepositoryUrl(event.target.value.replace(/\s/g, ''))}
                        />
                      </label>
                      <label>
                        <span>{t('linkMountPath')}</span>
                        <input
                          required
                          value={linkPath}
                          maxLength={4096}
                          spellCheck={false}
                          placeholder="Tools"
                          onChange={(event) => setLinkPath(event.target.value.replace(/[\r\n]/g, ''))}
                        />
                      </label>
                      <label>
                        <span>{t('linkSourcePath')}</span>
                        <input
                          required
                          value={linkSourcePath}
                          maxLength={4096}
                          spellCheck={false}
                          placeholder="/"
                          onChange={(event) => setLinkSourcePath(event.target.value.replace(/[\r\n]/g, ''))}
                        />
                      </label>
                      <label className="is-wide">
                        <span>{t('linkPinOptional')}</span>
                        <input
                          value={linkPin}
                          maxLength={4096}
                          spellCheck={false}
                          placeholder={t('loreDefaultPin')}
                          onChange={(event) => setLinkPin(event.target.value.replace(/[\r\n]/g, ''))}
                        />
                        <small>{t('noPinUsesLoreDefault')}</small>
                      </label>
                    </div>
                    <label className="composition-form__check">
                      <CheckboxInput
                        checked={linkDisableBranching}
                        onChange={(event) => setLinkDisableBranching(event.target.checked)}
                      />
                      <span>{t('disableAutomaticLinkBranching')}</span>
                    </label>
                    <footer>
                      <small>{t('stagedForNextRevision')}</small>
                      <span>
                        <button type="button" onClick={() => setLinkEditorOpen(false)} disabled={dialogBusy}>
                          {t('cancel')}
                        </button>
                        <button type="submit" className="is-primary" disabled={dialogBusy}>
                          {resourcePending ? <LoaderCircle className="is-spinning" size={14} /> : <Plus size={14} />}
                          {t('createLink')}
                        </button>
                      </span>
                    </footer>
                  </form>
                )}

                {editingLink && (
                  <form
                    className="composition-form composition-form--compact"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void submitLinkUpdate()
                    }}
                  >
                    <header>
                      <span>
                        <Pencil size={14} />
                        <strong>{t('updateLinkPin')}</strong>
                      </span>
                      <code>{editingLink.linkPath}</code>
                    </header>
                    <label>
                      <span>{t('linkPinOptional')}</span>
                      <input
                        value={editingLinkPin}
                        maxLength={4096}
                        spellCheck={false}
                        placeholder={t('loreDefaultPin')}
                        onChange={(event) => setEditingLinkPin(event.target.value.replace(/[\r\n]/g, ''))}
                      />
                    </label>
                    <footer>
                      <small>{t('stagedForNextRevision')}</small>
                      <span>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingLink(null)
                            setEditingLinkPin('')
                          }}
                          disabled={dialogBusy || !compositionAvailable}
                        >
                          {t('cancel')}
                        </button>
                        <button type="submit" className="is-primary" disabled={dialogBusy}>
                          {resourcePending ? <LoaderCircle className="is-spinning" size={14} /> : <Save size={14} />}
                          {t('updateLinkPin')}
                        </button>
                      </span>
                    </footer>
                  </form>
                )}

                <CompositionResourceList
                  empty={t('thisRepositoryHasNoLinks')}
                  icon={<Link2 size={17} />}
                  items={links.map((link) => ({
                    id: link.id,
                    title: link.linkPath,
                    detail: `${link.repository}:${link.sourcePath}`,
                    meta: `${link.branchName || '—'} · ${link.revision}`,
                    stagedFileCount: link.stagedFileCount,
                    badges: link.disableAutoFollow ? [t('automaticLinkBranchingDisabled')] : [],
                    actions: (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingLink(link)
                            setEditingLinkPin(link.branchName !== '—' ? link.branchName : link.revision)
                            setLinkEditorOpen(false)
                          }}
                          disabled={dialogBusy}
                        >
                          <Pencil size={13} />
                          {t('editPin')}
                        </button>
                        <button
                          type="button"
                          onClick={() => void submitLinkRemoval(link)}
                          disabled={dialogBusy || !compositionAvailable}
                        >
                          <Trash2 size={13} />
                          {t('removeLink')}
                        </button>
                      </>
                    )
                  }))}
                />
              </div>
            )}
            {tab === 'locks' && (
              <div className="lock-management">
                <div className="lock-management__notice">
                  <LockKeyhole size={16} />
                  <span>
                    <strong>{t('collaborativeLocks')}</strong>
                    <small>{t('collaborativeLockAdvisoryDescription')}</small>
                    {unidentifiedLockCount > 0 && (
                      <small className="lock-management__owner-warning">
                        {t('status.unidentifiedFileLockOwners', {
                          count: unidentifiedLockCount
                        })}
                        {' · '}
                        {t('unidentifiedFileLockOwnerDescription')}
                      </small>
                    )}
                  </span>
                  {unidentifiedLockCount > 0 && (
                    <button type="button" onClick={() => onTabChange('accounts')}>
                      <UserRound size={13} />
                      {t('accounts')}
                    </button>
                  )}
                </div>
                <form
                  className="lock-management__acquire"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void submitLockAcquire()
                  }}
                >
                  <label>
                    <span>{t('repositoryRelativePath')}</span>
                    <input
                      value={lockPath}
                      spellCheck={false}
                      placeholder="Content/Characters/Hero.uasset"
                      onChange={(event) => setLockPath(event.target.value)}
                    />
                  </label>
                  <button
                    type="submit"
                    className="is-primary"
                    disabled={dialogBusy || !lockAvailable || !lockPath.trim()}
                  >
                    <LockKeyhole size={13} />
                    {t('acquireCollaborativeLock')}
                  </button>
                </form>
                <label className="lock-management__filter">
                  <input
                    value={lockFilter}
                    placeholder={t('filterByPathOrOwner')}
                    aria-label={t('filterByPathOrOwner')}
                    onChange={(event) => setLockFilter(event.target.value)}
                  />
                </label>
                {visibleLocks.length === 0 ? (
                  <div className="dialog-empty">
                    <LockKeyhole size={26} />
                    <strong>{t('noCollaborativeLocks')}</strong>
                    <small>{t('locksComeFromCurrentBranch')}</small>
                  </div>
                ) : (
                  <ul className="lock-list">
                    {visibleLocks.map((lock) => (
                      <li key={`${lock.branch}:${lock.path}:${lock.owner}`}>
                        <LockKeyhole size={15} />
                        <span>
                          <strong>{lock.path}</strong>
                          <small
                            title={
                              isUnidentifiedFileLockOwner(lock.owner)
                                ? t('unidentifiedFileLockOwnerDescription')
                                : undefined
                            }
                          >
                            {t('status.lockOwnerBranch', {
                              owner: fileLockOwnerLabel(lock.owner),
                              branch: lock.branch
                            })}
                          </small>
                        </span>
                        <time dateTime={new Date(lock.lockedAt).toISOString()}>
                          {new Intl.DateTimeFormat(undefined, {
                            dateStyle: 'medium',
                            timeStyle: 'short'
                          }).format(lock.lockedAt)}
                        </time>
                        <button
                          type="button"
                          disabled={dialogBusy || !lockAvailable}
                          onClick={() => void submitLockRelease(lock.path)}
                        >
                          <LockKeyholeOpen size={13} />
                          {t('release')}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {tab === 'dependencies' && (
              <DependencyGraphPanel
                query={dependencyQuery}
                available={dependencyAvailable}
                loading={loading}
                onQuery={onQueryDependencies}
                onAdd={onAddDependency}
                onRemove={onRemoveDependency}
                onSync={onDependencySync}
              />
            )}
            {tab === 'collaboration' && (
              <BranchCollaborationPanel
                repositoryRevision={currentRevisionId ?? ''}
                branches={branches}
                disabled={loading || !compositionAvailable}
                onLoadBranch={onLoadBranchCollaboration}
                onLoadDiff={onLoadBranchDiff}
                onSetProtected={onSetBranchProtected}
                onReset={onResetBranchLatest}
              />
            )}
            {tab === 'revision' && (
              <RevisionRecoveryPanel
                currentRevision={currentRevisionId ?? ''}
                revisions={revisions}
                disabled={loading || !compositionAvailable}
                onLoadInfo={onLoadRevisionInfo}
                onFindNumber={onFindRevisionNumber}
                onFindMetadata={onFindRevisionMetadata}
                onAmend={onAmendRevision}
                onBisect={onBisectRevision}
                onRestore={onRestoreRevision}
                onLocate={onLocateRevision}
              />
            )}
            {tab === 'accounts' && (
              <AuthAccountsPanel
                remoteUrl={repository.remoteUrl ?? ''}
                refreshVersion={authStateVersion}
                disabled={loading || !compositionAvailable}
                onList={onListAuthIdentities}
                repositories={accountRepositories ?? [repository]}
                bindings={authAccountBindings ?? []}
                onBindingChange={onSetAuthAccountBinding ?? (async () => false)}
                onLoginInteractive={onLoginAuthInteractive}
                onLoginWithToken={onLoginAuthWithToken}
                onLogout={onLogoutAuthIdentity}
                onClear={onClearAuthIdentities}
              />
            )}

            {tab === 'metadata' && (
              <MetadataBrowserPanel
                branches={branches}
                revisions={revisions}
                currentRevision={currentRevisionId}
                onLoad={onLoadMetadata}
              />
            )}

            {tab === 'diagnostics' && (
              <RepositoryDiagnosticsPanel
                repositoryName={repository.name}
                currentRevision={currentRevisionId}
                onVerify={onVerifyPath}
                onVerifyFragment={onVerifyFragment}
                onDump={onDumpRepository}
                onListInstances={onListInstances}
                onPruneInstances={onPruneInstances}
                onUpdateInstancePath={onUpdateInstancePath}
              />
            )}
            {tab === 'maintenance' && (
              <div className="maintenance-actions">
                <article>
                  <span>
                    <ShieldCheck size={18} />
                  </span>
                  <div>
                    <strong>{t('verifyRepositoryStatus')}</strong>
                    <small>{t('checkLocalObjectsPointersWorkspace_dbb2')}</small>
                  </div>
                  <button type="button" onClick={onVerify} disabled={loading}>
                    <CheckCircle2 size={14} />
                    {t('startVerification')}
                  </button>
                </article>
                <article>
                  <span>
                    <Trash2 size={18} />
                  </span>
                  <div>
                    <strong>{t('collectUnreferencedContent')}</strong>
                    <small>{t('runLoreGcCleanStore_fc9e')}</small>
                  </div>
                  <button type="button" onClick={onCollectGarbage} disabled={loading}>
                    <Trash2 size={14} />
                    {t('runGc')}
                  </button>
                </article>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}

/** 用二进制单位展示预览体积，避免为摘要引入平台相关格式。 */
function formatViewBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`
}

function CompositionResourceList({
  empty,
  icon,
  items
}: {
  empty: string
  icon: React.ReactNode
  items: Array<{
    id: string
    title: string
    detail: string
    meta: string
    stagedFileCount: number
    badges: string[]
    actions: React.ReactNode
  }>
}) {
  const { t } = useTranslation()

  if (items.length === 0) {
    return (
      <div className="dialog-empty">
        {icon}
        <strong>{empty}</strong>
        <small>{t('resultsComeCurrentLoreCore_4bc2')}</small>
      </div>
    )
  }
  return (
    <ul className="resource-list">
      {items.map((item) => (
        <li key={item.id}>
          <span>{icon}</span>
          <div>
            <strong>{item.title}</strong>
            <code>{item.detail}</code>
            {(item.stagedFileCount > 0 || item.badges.length > 0) && (
              <span className="resource-list__badges">
                {item.stagedFileCount > 0 && (
                  <small className="is-staged">
                    {t('status.stagedFileCount', {
                      count: item.stagedFileCount
                    })}
                  </small>
                )}
                {item.badges.map((badge) => (
                  <small key={badge}>{badge}</small>
                ))}
              </span>
            )}
          </div>
          <small className="resource-list__meta">{item.meta}</small>
          <span className="resource-list__actions">{item.actions}</span>
        </li>
      ))}
    </ul>
  )
}
