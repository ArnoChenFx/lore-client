import {
  ChevronRight,
  Database,
  File,
  FolderOpen,
  GitFork,
  Layers3,
  LoaderCircle,
  Network,
  SlidersHorizontal,
  X
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { readErrorMessage } from '../../../shared/lib'
import { CheckboxInput, IconButton, NumberInput, TextButton, TextInput } from '../../../shared/ui'
import type { LoreCloneOptions, LoreSharedStoreInfo, RemoteRepository } from '../../../types'

interface CloneDialogProps {
  repository: RemoteRepository
  serverUrl: string
  sharedStoreInfo: LoreSharedStoreInfo | null
  busy: boolean
  onChooseParent: () => Promise<string | null>
  onChooseView: () => Promise<string | null>
  onConfirm: (parent: string, directoryName: string, viewPath: string, options: LoreCloneOptions) => void
  onClose: () => void
}

/**
 * 依赖参数的启用条件集中在这里，避免视觉禁用态、原生 disabled 属性和
 * 提示原因各自复制判断后发生漂移。
 */
export function resolveCloneDependencyAvailability(
  dependencyRootFiles: string,
  dependencyRecursive: boolean,
  materializationDisabled = false
) {
  const hasDependencyRootFiles = Boolean(dependencyRootFiles.trim())
  return {
    hasDependencyRootFiles,
    materializationDisabled,
    tagsDisabled: materializationDisabled || !hasDependencyRootFiles,
    transitiveDisabled: materializationDisabled || !hasDependencyRootFiles,
    depthDisabled: materializationDisabled || !hasDependencyRootFiles || !dependencyRecursive
  }
}

interface CloneSubmissionInput {
  viewPath: string
  targetRevision: string
  bare: boolean
  virtually: boolean
  directFileWrite: boolean
  layerRepository: string
  layerMetadataKey: string
  useSharedStore: boolean
  sharedStorePath?: string
  dependencyRootFiles: string
  dependencyTags: string
  dependencyRecursive: boolean
  dependencyDepthLimit: number
}

/**
 * 将 Clone 表单压缩成稳定 DTO，并主动移除不会生效的参数组合。
 *
 * Bare 不物化文件，因此 View、虚拟克隆、直接文件写入、Layer 和依赖闭包都必须
 * 从请求中消失；没有根文件时标签、递归和深度同样没有语义，不能把它们传给 Lore 后再
 * 让用户误以为筛选已经生效。
 */
export function buildCloneSubmission(input: CloneSubmissionInput): {
  viewPath: string
  options: LoreCloneOptions
} {
  const targetRevision = input.targetRevision.trim()
  const layerRepository = input.layerRepository.trim()
  const layerMetadataKey = input.layerMetadataKey.trim()
  const rootFiles = parseList(input.dependencyRootFiles)
  const materializeFiles = !input.bare
  const hasDependencyRoots = materializeFiles && rootFiles.length > 0

  return {
    viewPath: materializeFiles ? input.viewPath.trim() : '',
    options: {
      useSharedStore: input.useSharedStore,
      // Shared Store 未启用时不得发送路径，避免 Rust 端把残留输入误解为有效配置。
      sharedStorePath: input.useSharedStore ? input.sharedStorePath?.trim() || undefined : undefined,
      revision: targetRevision || undefined,
      bare: input.bare,
      virtually: materializeFiles && input.virtually,
      directFileWrite: materializeFiles && input.directFileWrite,
      layer:
        materializeFiles && layerRepository
          ? {
              repository: layerRepository,
              metadataKey: layerMetadataKey || undefined
            }
          : undefined,
      dependency: hasDependencyRoots
        ? {
            rootFiles,
            tags: parseList(input.dependencyTags),
            recursive: input.dependencyRecursive,
            depthLimit: input.dependencyRecursive ? input.dependencyDepthLimit : 0
          }
        : undefined
    }
  }
}

/** 收集克隆的本地落点和可选同步规则，实际路径校验由 Rust 端完成。 */
export function CloneDialog({
  repository,
  serverUrl,
  sharedStoreInfo,
  busy,
  onChooseParent,
  onChooseView,
  onConfirm,
  onClose
}: CloneDialogProps) {
  const { t } = useTranslation()
  const [parent, setParent] = useState('')
  const [directoryName, setDirectoryName] = useState(repository.name)
  const [viewPath, setViewPath] = useState('')
  const [targetRevision, setTargetRevision] = useState('')
  const [bare, setBare] = useState(false)
  const [virtually, setVirtually] = useState(false)
  const [directFileWrite, setDirectFileWrite] = useState(false)
  const [layerRepository, setLayerRepository] = useState('')
  const [layerMetadataKey, setLayerMetadataKey] = useState('')
  const [dependencyRootFiles, setDependencyRootFiles] = useState('')
  const [dependencyTags, setDependencyTags] = useState('')
  const [dependencyRecursive, setDependencyRecursive] = useState(true)
  const [dependencyDepthLimit, setDependencyDepthLimit] = useState(0)
  const dependencyAvailability = resolveCloneDependencyAvailability(dependencyRootFiles, dependencyRecursive, bare)
  const [activePicker, setActivePicker] = useState<'parent' | 'view' | null>(null)
  const [pickerError, setPickerError] = useState<{ kind: 'parent' | 'view'; message: string } | null>(null)
  const matchingStore =
    sharedStoreInfo?.stores.find(
      (store) => store.remoteUrl.replace(/\/+$/, '') === serverUrl.replace(/\/+$/, '') && store.exists
    ) ?? null
  const automaticSharedStore = sharedStoreInfo?.useAutomatically ?? false
  const [useSharedStore, setUseSharedStore] = useState(() => automaticSharedStore || Boolean(matchingStore))
  const [sharedStorePath, setSharedStorePath] = useState(() => matchingStore?.containerPath ?? '')

  useEffect(() => setDirectoryName(repository.name), [repository.name])
  useEffect(() => {
    setUseSharedStore(automaticSharedStore || Boolean(matchingStore))
    // 异步载入 Store 列表后，仅在用户尚未填写路径时使用匹配 Store 的容器路径。
    // 这样不会覆盖用户为本次 Clone 输入的显式路径。
    setSharedStorePath((currentPath) => currentPath || matchingStore?.containerPath || '')
  }, [automaticSharedStore, matchingStore])

  /**
   * 系统选择器可能需要数秒才出现，也可能在浏览器演示或权限不足时直接失败。
   * 按钮在等待期间显示旋转状态，失败则把结构化错误留在对应字段旁，避免点击后
   * 看起来完全没有响应。
   */
  const choosePath = async (
    kind: 'parent' | 'view',
    picker: () => Promise<string | null>,
    apply: (path: string) => void
  ) => {
    try {
      setActivePicker(kind)
      setPickerError(null)
      const selectedPath = await picker()
      if (selectedPath) apply(selectedPath)
    } catch (error) {
      setPickerError({ kind, message: readErrorMessage(error) })
    } finally {
      setActivePicker(null)
    }
  }

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <form
        className="task-dialog clone-dialog"
        aria-labelledby="clone-dialog-title"
        onSubmit={(event) => {
          event.preventDefault()
          if (parent.trim() && directoryName.trim()) {
            const submission = buildCloneSubmission({
              viewPath,
              targetRevision,
              bare,
              virtually,
              directFileWrite,
              layerRepository,
              layerMetadataKey,
              useSharedStore,
              sharedStorePath,
              dependencyRootFiles,
              dependencyTags,
              dependencyRecursive,
              dependencyDepthLimit
            })
            onConfirm(parent.trim(), directoryName.trim(), submission.viewPath, submission.options)
          }
        }}
      >
        <header className="task-dialog__header">
          <span className="task-dialog__mark">
            <GitFork size={18} />
          </span>
          <span>
            <small>LORE CLONE</small>
            <h2 id="clone-dialog-title">{t('status.cloneRepositoryName', { name: repository.name })}</h2>
          </span>
          <IconButton icon={<X size={16} />} label={t('closeCloneDialog')} onClick={onClose} disabled={busy} />
        </header>

        <div className="task-dialog__body">
          <section className="clone-remote-summary" aria-label={t('remoteRepositoryDetails')}>
            <span>
              <strong>{repository.description || t('noRepositoryDescription')}</strong>
              <small>{repository.remoteUrl || `${serverUrl}/${repository.name}`}</small>
            </span>
            <dl>
              <div>
                <dt>{t('defaultBranch')}</dt>
                <dd>{repository.defaultBranch || '—'}</dd>
              </div>
              <div>
                <dt>{t('repositoryCreator')}</dt>
                <dd>{repository.creator || '—'}</dd>
              </div>
              <div>
                <dt>{t('createdAt')}</dt>
                <dd>{repository.created ? new Date(repository.created * 1_000).toLocaleString() : '—'}</dd>
              </div>
              <div>
                <dt>{t('repositoryAccess')}</dt>
                <dd>{repository.permissions || t('remoteRepositoryPermissionsNotReported')}</dd>
              </div>
              <div>
                <dt>{t('cloneTargetRevision')}</dt>
                <dd>{repository.targetRevision || t('remoteCloneResolvesLatestRevision')}</dd>
              </div>
            </dl>
          </section>

          <label className="field-stack">
            <span>{t('localDirectoryName')}</span>
            <TextInput
              autoFocus
              value={directoryName}
              onChange={(event) => setDirectoryName(event.target.value)}
              spellCheck={false}
              required
            />
            <small>{t('newEmptyDirectoryUsedExisting_77cb')}</small>
          </label>

          <div className="field-stack">
            <span>{t('targetParentDirectory')}</span>
            <div className="path-picker">
              <code title={parent}>{parent || t('notSelectedYet')}</code>
              <TextButton
                aria-busy={activePicker === 'parent'}
                disabled={activePicker !== null}
                onClick={() => void choosePath('parent', onChooseParent, setParent)}
              >
                {activePicker === 'parent' ? (
                  <LoaderCircle className="is-spinning" size={14} />
                ) : (
                  <FolderOpen size={14} />
                )}
                {t('choose')}
              </TextButton>
            </div>
            {pickerError?.kind === 'parent' && (
              <small className="dialog-inline-error path-picker__error" role="alert">
                {pickerError.message}
              </small>
            )}
          </div>

          {/*
           * 精确目标、选择性物化与性能/依赖选项都不是日常 Clone 的必填信息。
           * 原生 details 在不引入额外状态的前提下提供鼠标、Enter/Space 和展开语义；
           * 不设置 open，确保每次打开对话框时优先呈现最短的常规 Clone 流程。
           */}
          <details className="clone-options">
            <summary>
              <span className="clone-options__title">
                <ChevronRight className="clone-options__chevron" size={15} aria-hidden="true" />
                <strong>{t('cloneAdvancedOptions')}</strong>
              </span>
              <small>{t('cloneAdvancedOptionsDescription')}</small>
            </summary>

            <div className="clone-options__body">
              <label className="field-stack">
                <span>{t('cloneTargetSpecifier')}</span>
                <TextInput
                  value={targetRevision}
                  onChange={(event) => setTargetRevision(event.target.value)}
                  placeholder={repository.defaultBranch || t('cloneTargetSpecifierPlaceholder')}
                  spellCheck={false}
                />
                <small>{t('cloneTargetSpecifierDescription')}</small>
              </label>

              <div className={`field-stack${bare ? ' is-disabled' : ''}`} aria-disabled={bare}>
                <span>{t('selectiveSyncRulesOptional')}</span>
                <div className="path-picker">
                  <code title={viewPath}>{viewPath || t('completeWorkspace')}</code>
                  {viewPath && (
                    <TextButton onClick={() => setViewPath('')} disabled={bare}>
                      {t('clear')}
                    </TextButton>
                  )}
                  <TextButton
                    aria-busy={activePicker === 'view'}
                    disabled={activePicker !== null || bare}
                    onClick={() => void choosePath('view', onChooseView, setViewPath)}
                  >
                    {activePicker === 'view' ? <LoaderCircle className="is-spinning" size={14} /> : <File size={14} />}
                    {t('chooseFile')}
                  </TextButton>
                </div>
                {bare && <small>{t('cloneBareDisablesMaterialization')}</small>}
                {pickerError?.kind === 'view' && (
                  <small className="dialog-inline-error path-picker__error" role="alert">
                    {pickerError.message}
                  </small>
                )}
              </div>

              <label className="clone-shared-store">
                <CheckboxInput
                  checked={useSharedStore}
                  disabled={automaticSharedStore}
                  onChange={(event) => setUseSharedStore(event.target.checked)}
                />
                <Database size={16} />
                <span>
                  <strong>{t('useSharedStoreForClone')}</strong>
                  <small>
                    {automaticSharedStore
                      ? t('sharedStoreAutomaticCloneHint')
                      : matchingStore
                        ? t('status.sharedStoreUsage', {
                            size: formatBytes(matchingStore.sizeBytes),
                            count: matchingStore.fileCount
                          })
                        : t('sharedStoreDefaultLookupHint')}
                  </small>
                </span>
              </label>
              <label className={`field-stack${!useSharedStore ? ' is-disabled' : ''}`} aria-disabled={!useSharedStore}>
                <span>{t('cloneSharedStorePathOptional')}</span>
                <TextInput
                  value={sharedStorePath}
                  disabled={!useSharedStore}
                  onChange={(event) => setSharedStorePath(event.target.value)}
                  placeholder={t('cloneSharedStorePathPlaceholder')}
                  spellCheck={false}
                />
                <small>{t('cloneSharedStorePathDescription')}</small>
              </label>

              <fieldset className="clone-advanced">
                <legend>
                  <SlidersHorizontal size={15} />
                  {t('cloneAdvancedModes')}
                </legend>
                <small>{t('cloneAdvancedModesDescription')}</small>
                <div className="clone-advanced__options">
                  <label className="clone-advanced__option">
                    <CheckboxInput checked={bare} onChange={(event) => setBare(event.target.checked)} />
                    <span>
                      <strong>{t('cloneBare')}</strong>
                      <small>{t('cloneBareDescription')}</small>
                    </span>
                  </label>
                  <label className={`clone-advanced__option${bare ? ' is-disabled' : ''}`} aria-disabled={bare}>
                    <CheckboxInput
                      checked={virtually}
                      disabled={bare}
                      onChange={(event) => setVirtually(event.target.checked)}
                    />
                    <span>
                      <strong>{t('cloneVirtually')}</strong>
                      <small>{bare ? t('cloneBareDisablesMaterialization') : t('cloneVirtuallyDescription')}</small>
                    </span>
                  </label>
                  <label className={`clone-advanced__option${bare ? ' is-disabled' : ''}`} aria-disabled={bare}>
                    <CheckboxInput
                      checked={directFileWrite}
                      disabled={bare}
                      onChange={(event) => setDirectFileWrite(event.target.checked)}
                    />
                    <span>
                      <strong>{t('cloneDirectFileWrite')}</strong>
                      <small>
                        {bare ? t('cloneBareDisablesMaterialization') : t('cloneDirectFileWriteDescription')}
                      </small>
                    </span>
                  </label>
                </div>
                <div className={`clone-advanced__layer${bare ? ' is-disabled' : ''}`} aria-disabled={bare}>
                  <span className="clone-advanced__layer-title">
                    <Layers3 size={14} />
                    <strong>{t('cloneInitialLayer')}</strong>
                  </span>
                  <label className="field-stack">
                    <span>{t('cloneLayerRepository')}</span>
                    <TextInput
                      value={layerRepository}
                      disabled={bare}
                      onChange={(event) => setLayerRepository(event.target.value)}
                      placeholder={t('cloneLayerRepositoryPlaceholder')}
                      spellCheck={false}
                    />
                  </label>
                  <label className="field-stack">
                    <span>{t('cloneLayerMetadataKey')}</span>
                    <TextInput
                      value={layerMetadataKey}
                      disabled={bare || !layerRepository.trim()}
                      onChange={(event) => setLayerMetadataKey(event.target.value)}
                      placeholder={t('cloneLayerMetadataKeyPlaceholder')}
                      spellCheck={false}
                    />
                    {!bare && !layerRepository.trim() && <small>{t('cloneLayerRepositoryRequired')}</small>}
                  </label>
                  <small>{bare ? t('cloneBareDisablesMaterialization') : t('cloneInitialLayerDescription')}</small>
                </div>
              </fieldset>

              <fieldset className={`clone-dependencies${bare ? ' is-disabled' : ''}`} aria-disabled={bare}>
                <legend>
                  <Network size={15} />
                  {t('dependencyDrivenClone')}
                </legend>
                <small>{bare ? t('cloneBareDisablesMaterialization') : t('dependencyDrivenCloneDescription')}</small>
                <label className="field-stack">
                  <span>{t('dependencyRootFilesOptional')}</span>
                  <textarea
                    value={dependencyRootFiles}
                    disabled={bare}
                    spellCheck={false}
                    placeholder={'Content/Maps/World.umap\nContent/Characters/Hero.uasset'}
                    onChange={(event) => setDependencyRootFiles(event.target.value)}
                  />
                </label>
                <label className="field-stack">
                  <span>{t('dependencyTagsOptional')}</span>
                  <TextInput
                    value={dependencyTags}
                    disabled={dependencyAvailability.tagsDisabled}
                    spellCheck={false}
                    placeholder="runtime, high-resolution"
                    onChange={(event) => setDependencyTags(event.target.value)}
                  />
                  {dependencyAvailability.tagsDisabled && (
                    <small>
                      {bare ? t('cloneBareDisablesMaterialization') : t('dependencyOptionRequiresRootFiles')}
                    </small>
                  )}
                </label>
                <div className="clone-dependencies__options">
                  <label
                    className={`clone-dependencies__option${
                      dependencyAvailability.transitiveDisabled ? ' is-disabled' : ''
                    }`}
                    aria-disabled={dependencyAvailability.transitiveDisabled}
                  >
                    <span className="clone-dependencies__option-main">
                      <CheckboxInput
                        checked={dependencyRecursive}
                        disabled={dependencyAvailability.transitiveDisabled}
                        aria-describedby={
                          dependencyAvailability.transitiveDisabled ? 'clone-transitive-disabled-reason' : undefined
                        }
                        onChange={(event) => setDependencyRecursive(event.target.checked)}
                      />
                      <span>{t('includeTransitiveDependencies')}</span>
                    </span>
                    {dependencyAvailability.transitiveDisabled && (
                      <small id="clone-transitive-disabled-reason">
                        {bare ? t('cloneBareDisablesMaterialization') : t('dependencyOptionRequiresRootFiles')}
                      </small>
                    )}
                  </label>
                  <label
                    className={`clone-dependencies__option clone-dependencies__option--depth${
                      dependencyAvailability.depthDisabled ? ' is-disabled' : ''
                    }`}
                    aria-disabled={dependencyAvailability.depthDisabled}
                  >
                    <span className="clone-dependencies__option-main">
                      <span>{t('dependencyDepthLimit')}</span>
                      <NumberInput
                        min={0}
                        max={1024}
                        value={dependencyDepthLimit}
                        disabled={dependencyAvailability.depthDisabled}
                        aria-describedby={
                          dependencyAvailability.depthDisabled ? 'clone-depth-disabled-reason' : undefined
                        }
                        onChange={(event) =>
                          setDependencyDepthLimit(Math.max(0, Math.min(1024, Number(event.target.value) || 0)))
                        }
                      />
                    </span>
                    {dependencyAvailability.depthDisabled && (
                      <small id="clone-depth-disabled-reason">
                        {bare
                          ? t('cloneBareDisablesMaterialization')
                          : dependencyAvailability.hasDependencyRootFiles
                            ? t('dependencyDepthRequiresTransitive')
                            : t('dependencyOptionRequiresRootFiles')}
                      </small>
                    )}
                  </label>
                </div>
              </fieldset>
            </div>
          </details>
        </div>

        <footer className="task-dialog__footer">
          <TextButton onClick={onClose} disabled={busy}>
            {t('cancel')}
          </TextButton>
          <TextButton variant="primary" type="submit" disabled={busy || !parent.trim() || !directoryName.trim()}>
            {busy ? <LoaderCircle className="is-spinning" size={15} /> : <GitFork size={15} />}
            {busy ? t('cloning') : t('startClone')}
          </TextButton>
        </footer>
      </form>
    </div>
  )
}

/** 允许逐行或逗号输入，同时保持稳定顺序并去重。 */
function parseList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ]
}

/** Clone 对话框只需紧凑、稳定的二进制容量显示，不把格式化结果写入持久状态。 */
function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1_024)), units.length - 1)
  return `${(bytes / 1_024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`
}
