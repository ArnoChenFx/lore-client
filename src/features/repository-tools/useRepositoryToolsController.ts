import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { confirmLocalized, t } from '../../i18n'
import {
  acquireFileLocks,
  addFileDependency,
  addLayer,
  addLink,
  amendCurrentRevision,
  applyRepositoryView,
  bisectRevisionRange,
  clearAuthIdentities,
  collectRepositoryGarbage,
  dumpRepositoryState,
  findRevisionByMetadata,
  findRevisionByNumber,
  listAuthIdentities,
  listLayers,
  listLinks,
  listRemoteRepositories,
  listRepositoryInstances,
  loadBranchCollaboration,
  loadBranchDiff,
  loadFileDependencyGraph,
  loadFileLockStatus,
  loadMetadata,
  loadRepositoryView,
  loadRevisionInfo,
  loginAuthInteractive,
  loginAuthWithToken,
  logoutAuthIdentity,
  previewRepositoryView,
  pruneRepositoryInstances,
  publishRepository,
  LoreRepositoryPublishError,
  queryFileLocks,
  releaseFileLocks,
  removeFileDependency,
  removeLayer,
  removeLink,
  resetBranchLatest,
  restoreCurrentRevision,
  setRepositoryAuthAccountBinding,
  setBranchProtected,
  syncRepository,
  updateLink,
  updateRepositoryConfig,
  updateRepositoryInstancePath,
  verifyRepository,
  verifyRepositoryFragment,
  verifyRepositoryPath
} from '../../services/lore'
import { readErrorMessage } from '../../shared/lib'
import { changeFilePath } from '../../shared/lib'
import type {
  ApplicationMode,
  LoreDependencyGraphQuery,
  LoreDependencySelection,
  LoreDiagnosticReport,
  LoreFileLock,
  LoreAuthIdentity,
  LoreLayer,
  LoreLayerAddRequest,
  LoreLayerRemoveRequest,
  LoreLink,
  LoreLinkAddRequest,
  LoreLinkUpdateRequest,
  RepositorySnapshot,
  RepositoryAuthAccountBinding,
  RemoteRepository,
  RepositoryView,
  RepositoryViewPreview,
  ToastMessage
} from '../../types'
import { operationMessage } from '../operations'
import type {
  RepositoryMutationRunner,
  RepositoryToolTab,
  RepositoryToolsController,
  RepositoryToolsDialogProps
} from './types'

const REPOSITORY_TOOL_BUSY_ACTIONS = new Set([
  'updateRepositoryConfiguration',
  'publishRepository',
  'pushBranch',
  'verifyRepository',
  'collectStorage',
  'applyRepositoryView',
  'addLayer',
  'removeLayer',
  'addLink',
  'updateLinkPin',
  'removeLink',
  'addFileDependency',
  'removeFileDependency',
  'dependencyDrivenSync',
  'protectBranch',
  'unprotectBranch',
  'resetBranchLatest',
  'amendRevision',
  'bisectRevision',
  'restoreRevision',
  'loginAuthInteractive',
  'loginAuthWithToken',
  'logoutAuthIdentity',
  'clearAuthIdentities',
  'healRepository',
  'pruneRepositoryInstances',
  'updateRepositoryInstancePath'
])

/** 只把真正阻塞 Repository Tools 的仓库写操作映射为弹层加载态。 */
export function isRepositoryToolsBusy(busyAction: string | null): boolean {
  return busyAction !== null && REPOSITORY_TOOL_BUSY_ACTIONS.has(busyAction)
}

/** 文件菜单和目录批量操作可能传入重复或空路径，进入 Lore 前统一规范化。 */
export function normalizeRepositoryToolPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => path.trim()).filter(Boolean))]
}

/**
 * 从服务器目录定位当前本地仓库连接的远端对象。
 *
 * Repository ID 是首选稳定标识；名称只用于兼容旧仓库或异常服务器未返回一致 ID
 * 的场景，且不会从本地路径或 URL 文本猜测新的远端名称。
 */
export function findConnectedRemoteRepository(
  repositories: readonly RemoteRepository[],
  repositoryId: string,
  repositoryName: string
): RemoteRepository | undefined {
  return (
    repositories.find((repository) => repository.id === repositoryId) ??
    repositories.find((repository) => repository.name === repositoryName)
  )
}

export interface ResolvedPublishAuthAccount {
  authUrl: string
  userId: string
  /** `true` 表示没有仓库绑定，但设备上只有一个账户，可以安全地自动绑定。 */
  inferred: boolean
}

/** 仅识别远端尚未创建时返回的稳定认证错误，避免对权限或重名失败盲目重试。 */
export function isPublishAuthenticationError(error: unknown): boolean {
  return error instanceof LoreRepositoryPublishError && error.result.failureCode === 'auth_required'
}

/**
 * 为发布操作解析确定的认证账户。
 *
 * 仓库绑定优先于设备账户列表；只有设备上恰好一个账户时才允许自动选择，避免多账户
 * 环境把远端仓库创建到错误身份下。没有唯一答案时由调用方提示用户前往账户页绑定。
 */
export function resolvePublishAuthAccount(
  repositoryPath: string,
  bindings: readonly RepositoryAuthAccountBinding[],
  identities: readonly LoreAuthIdentity[]
): ResolvedPublishAuthAccount | null {
  const normalizedPath = repositoryPath
    .trim()
    .replace(/[\\/]+$/, '')
    .toLocaleLowerCase()
  const binding = bindings.find(
    (candidate) =>
      candidate.repositoryPath
        .trim()
        .replace(/[\\/]+$/, '')
        .toLocaleLowerCase() === normalizedPath && candidate.userId.trim().length > 0
  )
  if (binding) {
    return {
      authUrl: binding.authUrl,
      userId: binding.userId.trim(),
      inferred: false
    }
  }

  /*
   * Auth List 可能为同一用户返回身份根条目和多个资源授权条目。自动选择按 userId
   * 去重，不能把同一账户的多条资源记录误判成多账户歧义。
   */
  const uniqueIdentities = [
    ...new Map(
      identities
        .filter((identity) => identity.userId.trim().length > 0)
        .map((identity) => [identity.userId.trim(), identity] as const)
    ).values()
  ]
  if (uniqueIdentities.length !== 1) {
    return null
  }
  return {
    authUrl: uniqueIdentities[0]!.authUrl,
    userId: uniqueIdentities[0]!.userId.trim(),
    inferred: true
  }
}

type Notify = (title: string, detail: string, tone?: ToastMessage['tone']) => void

interface UseRepositoryToolsControllerOptions {
  applicationMode: ApplicationMode
  activeSnapshot?: RepositorySnapshot
  repositorySnapshots: RepositorySnapshot[]
  authAccountBindings: RepositoryAuthAccountBinding[]
  onAuthAccountBindingsChange: (bindings: RepositoryAuthAccountBinding[]) => void
  defaultIdentity: string
  busyAction: string | null
  initialDependencyQuery?: LoreDependencyGraphQuery | null
  notify: Notify
  openRepository: () => Promise<unknown>
  runRepositoryMutation: RepositoryMutationRunner
  upsertSnapshot: (snapshot: RepositorySnapshot) => void
  pushCurrentRepository: () => Promise<unknown>
  locateRevision: (revision: string) => void
}

/**
 * Repository Tools 的领域控制器。
 *
 * 控制器拥有页签资源、惰性读取、写操作和对话框契约；App 仅负责提供统一仓库写入入口
 * 与少量跨领域导航。所有真实 Lore 调用仍经过 `services/lore.ts`，组件不接触 IPC。
 */
export function useRepositoryToolsController({
  applicationMode,
  activeSnapshot,
  repositorySnapshots,
  authAccountBindings,
  onAuthAccountBindingsChange,
  defaultIdentity,
  busyAction,
  initialDependencyQuery = null,
  notify,
  openRepository,
  runRepositoryMutation,
  upsertSnapshot,
  pushCurrentRepository,
  locateRevision
}: UseRepositoryToolsControllerOptions): RepositoryToolsController {
  const [tab, setTab] = useState<RepositoryToolTab | null>(null)
  const [layers, setLayers] = useState<LoreLayer[]>([])
  const [links, setLinks] = useState<LoreLink[]>([])
  const [fileLocks, setFileLocks] = useState<LoreFileLock[]>([])
  const [fileLockState, setFileLockState] = useState<'loading' | 'ready' | 'unavailable'>(
    applicationMode === 'tauri' ? 'loading' : 'unavailable'
  )
  const [dependencyQuery, setDependencyQuery] = useState<LoreDependencyGraphQuery | null>(initialDependencyQuery)
  const [repositoryView, setRepositoryView] = useState<RepositoryView | null>(null)
  const [connectedRemoteDescription, setConnectedRemoteDescription] = useState('')
  const [connectedRemoteName, setConnectedRemoteName] = useState('')
  const [publishAuthIdentities, setPublishAuthIdentities] = useState<LoreAuthIdentity[]>([])
  const [loading, setLoading] = useState(false)
  const resourceRequestCounter = useRef(0)
  const lockRequestCounter = useRef(0)

  useEffect(() => {
    /*
     * Repository Tools 可以在多项目标签间保持打开。切换仓库时先清空上一仓库的
     * 远端说明和发布账户快照，避免新仓库资源返回前短暂显示上一仓库的数据。
     */
    setConnectedRemoteDescription('')
    setConnectedRemoteName('')
    setPublishAuthIdentities([])
  }, [activeSnapshot?.repository.path])

  /** 读取协作锁时使用独立序号，工具页全量 Query 与工作区路径 Status 不得互相覆盖。 */
  const loadLocks = useCallback(
    async (paths?: string[]): Promise<LoreFileLock[]> => {
      if (!activeSnapshot || applicationMode !== 'tauri') {
        setFileLocks([])
        setFileLockState('unavailable')
        return []
      }
      const requestId = ++lockRequestCounter.current
      setFileLockState('loading')
      try {
        const result = paths
          ? await loadFileLockStatus(
              activeSnapshot.repository.path,
              activeSnapshot.repository.branch,
              normalizeRepositoryToolPaths(paths)
            )
          : await queryFileLocks(activeSnapshot.repository.path, activeSnapshot.repository.branch)
        if (requestId === lockRequestCounter.current) {
          setFileLocks(result)
          setFileLockState('ready')
        }
        return result
      } catch (error) {
        if (requestId === lockRequestCounter.current) {
          setFileLocks([])
          setFileLockState('unavailable')
        }
        throw error
      }
    },
    [activeSnapshot, applicationMode]
  )

  /**
   * 普通工作区只查询当前变更路径，避免每次快照刷新触发无界全仓 Lock Query。
   * 锁是附加协作信息，读取失败不能覆盖真实文件状态。
   */
  useEffect(() => {
    if (applicationMode !== 'tauri') {
      lockRequestCounter.current += 1
      setFileLocks([])
      setFileLockState('unavailable')
      return
    }
    if (!activeSnapshot || activeSnapshot.changes.length === 0) {
      lockRequestCounter.current += 1
      setFileLocks([])
      setFileLockState('ready')
      return
    }
    void loadLocks(activeSnapshot.changes.map(changeFilePath)).catch(() => {
      // 工作区刷新保持静默；菜单会通过 unavailable 状态给出明确不可用原因。
    })
  }, [activeSnapshot, applicationMode, loadLocks])

  const close = useCallback(() => {
    resourceRequestCounter.current += 1
    setTab(null)
    setLoading(false)
  }, [])

  const open = useCallback(
    async (nextTab: RepositoryToolTab) => {
      if (!activeSnapshot && nextTab !== 'accounts') {
        await openRepository()
        return
      }

      setTab(nextTab)
      const requestId = ++resourceRequestCounter.current
      if (nextTab === 'accounts' || nextTab === 'maintenance' || applicationMode !== 'tauri') {
        return
      }
      if (!activeSnapshot) return

      if (nextTab === 'configuration') {
        setConnectedRemoteDescription('')
        setConnectedRemoteName('')
        setPublishAuthIdentities([])
      }

      try {
        setLoading(true)
        if (nextTab === 'configuration') {
          /*
           * 发布账户属于设备级资源，即使仓库尚未保存服务器地址也必须读取；这让用户
           * 可以先填写发布目标，再明确选择登录账户或留空进行匿名发布。
           */
          const identities = await listAuthIdentities().catch(() => [])
          if (requestId === resourceRequestCounter.current) {
            setPublishAuthIdentities(identities)
          }
          if (!activeSnapshot.repository.serverUrl) {
            return
          }
          /*
           * 仓库配置只保存服务器根地址，远端名称不能从 URL 截取。先读取目录，再按
           * Repository ID 匹配同一仓库；已有账户绑定用于访问受保护服务器。
           */
          const account = resolvePublishAuthAccount(activeSnapshot.repository.path, authAccountBindings, identities)
          const repositories = await listRemoteRepositories(activeSnapshot.repository.serverUrl, account?.userId)
          const connectedRepository = findConnectedRemoteRepository(
            repositories,
            activeSnapshot.repository.id,
            activeSnapshot.repository.name
          )
          if (requestId === resourceRequestCounter.current) {
            setConnectedRemoteDescription(connectedRepository?.description ?? '')
            setConnectedRemoteName(connectedRepository?.name ?? '')
          }
        } else if (nextTab === 'view') {
          const result = await loadRepositoryView(activeSnapshot.repository.path)
          if (requestId === resourceRequestCounter.current) setRepositoryView(result)
        } else if (nextTab === 'layers') {
          const result = await listLayers(activeSnapshot.repository.path)
          if (requestId === resourceRequestCounter.current) setLayers(result)
        } else if (nextTab === 'locks') {
          await loadLocks()
        } else if (nextTab === 'dependencies') {
          /*
           * 依赖查询必须由明确根文件驱动。打开页签只清除上一仓库结果，
           * 不对大型仓库执行无界扫描。
           */
          if (requestId === resourceRequestCounter.current) setDependencyQuery(null)
        } else if (
          nextTab !== 'collaboration' &&
          nextTab !== 'revision' &&
          nextTab !== 'metadata' &&
          nextTab !== 'diagnostics'
        ) {
          const result = await listLinks(activeSnapshot.repository.path)
          if (requestId === resourceRequestCounter.current) setLinks(result)
        }
      } catch (error) {
        if (requestId !== resourceRequestCounter.current) return
        if (nextTab === 'configuration') {
          /*
           * 远端说明只是发布表单的便利初值。离线、权限不足或服务器版本不兼容时
           * 保持空值即可，不能阻止用户编辑本地身份和服务器配置。
           */
          setConnectedRemoteDescription('')
          setConnectedRemoteName('')
          return
        }
        notify(
          t('status.failedToLoad', {
            name:
              nextTab === 'view'
                ? t('selectiveSyncView')
                : nextTab === 'layers'
                  ? t('layers')
                  : nextTab === 'locks'
                    ? t('collaborativeLocks')
                    : nextTab === 'dependencies'
                      ? t('fileDependencyGraph')
                      : nextTab === 'collaboration'
                        ? t('branchCollaboration')
                        : nextTab === 'revision'
                          ? t('revisionRecovery')
                          : t('links')
          }),
          readErrorMessage(error),
          'warning'
        )
      } finally {
        if (requestId === resourceRequestCounter.current) setLoading(false)
      }
    },
    [activeSnapshot, applicationMode, authAccountBindings, loadLocks, notify, openRepository]
  )

  const setActiveBranchProtected = useCallback(
    async (branch: string, protectedValue: boolean) => {
      if (!confirmLocalized(t(protectedValue ? 'confirm.protectBranch' : 'confirm.unprotectBranch', { branch }))) {
        return false
      }
      return runRepositoryMutation(
        protectedValue ? 'protectBranch' : 'unprotectBranch',
        (repository) => setBranchProtected(repository.path, branch, protectedValue),
        operationMessage(protectedValue ? 'status.branchProtected' : 'status.branchUnprotected', { branch })
      )
    },
    [runRepositoryMutation]
  )

  const resetActiveBranchLatest = useCallback(
    async (
      branch: string,
      revision: string,
      expectedWorkspaceRevision: string,
      expectedLatest: string,
      skippedEntries: number
    ) => {
      if (
        !confirmLocalized(
          t('confirm.resetBranchLatest', {
            branch,
            revision: revision.slice(0, 12),
            latest: expectedLatest.slice(0, 12),
            count: skippedEntries
          })
        )
      ) {
        return false
      }
      return runRepositoryMutation(
        'resetBranchLatest',
        (repository) => resetBranchLatest(repository.path, branch, revision, expectedWorkspaceRevision, expectedLatest),
        operationMessage('status.branchLatestReset', {
          branch,
          revision: revision.slice(0, 12)
        })
      )
    },
    [runRepositoryMutation]
  )

  const amendActiveRevision = useCallback(
    async (message: string) => {
      if (!activeSnapshot) return false
      if (
        !confirmLocalized(
          t('confirm.amendRevision', {
            revision: activeSnapshot.repository.revision.slice(0, 12)
          })
        )
      ) {
        return false
      }
      return runRepositoryMutation(
        'amendRevision',
        (repository) => amendCurrentRevision(repository.path, repository.branch, repository.revision, message),
        operationMessage('status.revisionAmended')
      )
    },
    [activeSnapshot, runRepositoryMutation]
  )

  const bisectActiveRevision = useCallback(
    async (start: string, end: string) => {
      if (!activeSnapshot) return false
      if (
        !confirmLocalized(
          t('confirm.bisectRevision', {
            start: start.slice(0, 12),
            end: end.slice(0, 12)
          })
        )
      ) {
        return false
      }
      return runRepositoryMutation(
        'bisectRevision',
        (repository) =>
          bisectRevisionRange(repository.path, start, end, repository.revision).then(({ operation }) => operation),
        operationMessage('status.bisectMidpointLoaded')
      )
    },
    [activeSnapshot, runRepositoryMutation]
  )

  const restoreActiveRevision = useCallback(
    async (message: string) => {
      if (!activeSnapshot) return false
      if (
        !confirmLocalized(
          t('confirm.restoreRevision', {
            revision: activeSnapshot.repository.revision.slice(0, 12),
            branch: activeSnapshot.repository.branch
          })
        )
      ) {
        return false
      }
      return runRepositoryMutation(
        'restoreRevision',
        (repository) => restoreCurrentRevision(repository.path, repository.revision, message),
        operationMessage('status.revisionRestoredAsNew')
      )
    },
    [activeSnapshot, runRepositoryMutation]
  )

  const acquireActiveFileLocks = useCallback(
    async (paths: string[]) => {
      const uniquePaths = normalizeRepositoryToolPaths(paths)
      if (uniquePaths.length === 0) return false
      const succeeded = await runRepositoryMutation(
        'acquireCollaborativeLock',
        (repository) => acquireFileLocks(repository.path, repository.branch, uniquePaths),
        uniquePaths.length === 1
          ? operationMessage('status.collaborativeLockAcquired', {
              path: uniquePaths[0]
            })
          : operationMessage('status.collaborativeLocksAcquired', {
              count: uniquePaths.length
            })
      )
      if (succeeded) {
        try {
          await loadLocks()
        } catch (error) {
          notify(t('failedToRefreshCollaborativeLocks'), readErrorMessage(error), 'warning')
        }
      }
      return succeeded
    },
    [loadLocks, notify, runRepositoryMutation]
  )

  const releaseActiveFileLocks = useCallback(
    async (paths: string[]) => {
      const uniquePaths = normalizeRepositoryToolPaths(paths)
      if (uniquePaths.length === 0) return false
      const succeeded = await runRepositoryMutation(
        'releaseCollaborativeLock',
        (repository) => releaseFileLocks(repository.path, repository.branch, uniquePaths),
        uniquePaths.length === 1
          ? operationMessage('status.collaborativeLockReleased', {
              path: uniquePaths[0]
            })
          : operationMessage('status.collaborativeLocksReleased', {
              count: uniquePaths.length
            })
      )
      if (succeeded) {
        try {
          await loadLocks()
        } catch (error) {
          notify(t('failedToRefreshCollaborativeLocks'), readErrorMessage(error), 'warning')
        }
      }
      return succeeded
    },
    [loadLocks, notify, runRepositoryMutation]
  )

  const queryActiveDependencies = useCallback(
    async (
      paths: string[],
      options: LoreDependencySelection,
      reverse: boolean
    ): Promise<LoreDependencyGraphQuery | null> => {
      if (!activeSnapshot || applicationMode !== 'tauri') return null
      try {
        setLoading(true)
        const result = await loadFileDependencyGraph(
          activeSnapshot.repository.path,
          paths,
          options,
          reverse,
          activeSnapshot.repository.revision
        )
        setDependencyQuery(result)
        return result
      } catch (error) {
        notify(t('dependencyQueryFailed'), readErrorMessage(error), 'warning')
        return null
      } finally {
        setLoading(false)
      }
    },
    [activeSnapshot, applicationMode, notify]
  )

  const refreshCompositionResources = useCallback(
    async (kind: 'layers' | 'links', repositoryPath: string) => {
      try {
        if (kind === 'layers') {
          setLayers(await listLayers(repositoryPath))
        } else {
          setLinks(await listLinks(repositoryPath))
        }
      } catch (error) {
        notify(
          t('status.failedToLoad', {
            name: kind === 'layers' ? t('layers') : t('links')
          }),
          readErrorMessage(error),
          'warning'
        )
      }
    },
    [notify]
  )

  const addActiveLayer = useCallback(
    async (request: LoreLayerAddRequest): Promise<boolean> => {
      if (!activeSnapshot) return false
      const repositoryPath = activeSnapshot.repository.path
      const succeeded = await runRepositoryMutation(
        'addLayer',
        (repository) => addLayer(repository.path, request),
        operationMessage('status.layerAdded', { path: request.targetPath })
      )
      if (succeeded) await refreshCompositionResources('layers', repositoryPath)
      return succeeded
    },
    [activeSnapshot, refreshCompositionResources, runRepositoryMutation]
  )

  const removeActiveLayer = useCallback(
    async (request: LoreLayerRemoveRequest): Promise<boolean> => {
      if (!activeSnapshot) return false
      const repositoryPath = activeSnapshot.repository.path
      const succeeded = await runRepositoryMutation(
        'removeLayer',
        (repository) => removeLayer(repository.path, request),
        operationMessage('status.layerRemoved', { path: request.targetPath })
      )
      if (succeeded) await refreshCompositionResources('layers', repositoryPath)
      return succeeded
    },
    [activeSnapshot, refreshCompositionResources, runRepositoryMutation]
  )

  const addActiveLink = useCallback(
    async (request: LoreLinkAddRequest): Promise<boolean> => {
      if (!activeSnapshot) return false
      const repositoryPath = activeSnapshot.repository.path
      const succeeded = await runRepositoryMutation(
        'addLink',
        (repository) => addLink(repository.path, request),
        operationMessage('status.linkAdded', { path: request.linkPath })
      )
      if (succeeded) await refreshCompositionResources('links', repositoryPath)
      return succeeded
    },
    [activeSnapshot, refreshCompositionResources, runRepositoryMutation]
  )

  const updateActiveLink = useCallback(
    async (request: LoreLinkUpdateRequest): Promise<boolean> => {
      if (!activeSnapshot) return false
      const repositoryPath = activeSnapshot.repository.path
      const succeeded = await runRepositoryMutation(
        'updateLinkPin',
        (repository) => updateLink(repository.path, request),
        operationMessage('status.linkPinUpdated', { path: request.linkPath })
      )
      if (succeeded) await refreshCompositionResources('links', repositoryPath)
      return succeeded
    },
    [activeSnapshot, refreshCompositionResources, runRepositoryMutation]
  )

  const removeActiveLink = useCallback(
    async (linkPath: string): Promise<boolean> => {
      if (!activeSnapshot) return false
      const repositoryPath = activeSnapshot.repository.path
      const succeeded = await runRepositoryMutation(
        'removeLink',
        (repository) => removeLink(repository.path, linkPath),
        operationMessage('status.linkRemoved', { path: linkPath })
      )
      if (succeeded) await refreshCompositionResources('links', repositoryPath)
      return succeeded
    },
    [activeSnapshot, refreshCompositionResources, runRepositoryMutation]
  )

  const previewActiveRepositoryView = useCallback(
    async (content: string): Promise<RepositoryViewPreview> => {
      const revision = activeSnapshot?.repository.revision
      if (!activeSnapshot || !revision) throw new Error(t('repositoryViewRequiresCurrentRevision'))
      return previewRepositoryView(activeSnapshot.repository.path, revision, content)
    },
    [activeSnapshot]
  )

  const applyActiveRepositoryView = useCallback(
    async (content: string): Promise<boolean> => {
      const revision = activeSnapshot?.repository.revision
      if (!activeSnapshot || !revision) return false
      const applied = await runRepositoryMutation(
        'applyRepositoryView',
        (repository) => applyRepositoryView(repository.path, revision, content),
        operationMessage('repositoryViewAppliedAndSynchronized')
      )
      if (applied) {
        try {
          setRepositoryView(await loadRepositoryView(activeSnapshot.repository.path))
        } catch (error) {
          notify(t('repositoryViewApplied'), readErrorMessage(error), 'warning')
        }
      }
      return applied
    },
    [activeSnapshot, notify, runRepositoryMutation]
  )

  const saveRepositoryConfiguration = useCallback(
    async (identity: string, remoteUrl: string) => {
      if (!activeSnapshot) return
      if (applicationMode === 'browser-demo') {
        const normalizedIdentity = identity.trim() || undefined
        const normalizedRemoteUrl = remoteUrl.trim().replace(/\/+$/, '') || undefined
        upsertSnapshot({
          ...activeSnapshot,
          repository: {
            ...activeSnapshot.repository,
            identity: normalizedIdentity,
            remoteUrl: normalizedRemoteUrl
          }
        })
        notify(t('demoConfigurationUpdated'), t('browserModeUpdatesCurrentSession_1b10'), 'info')
        return
      }
      await runRepositoryMutation(
        'updateRepositoryConfiguration',
        (repository) => updateRepositoryConfig(repository.path, identity, remoteUrl),
        operationMessage('repositoryIdentityAndRemoteUrlSaved')
      )
    },
    [activeSnapshot, applicationMode, notify, runRepositoryMutation, upsertSnapshot]
  )

  const publishActiveRepository = useCallback(
    async (
      identity: string,
      targetServerUrl: string,
      repositoryName: string,
      description: string,
      authUserId?: string
    ) => {
      if (!activeSnapshot) return
      if (applicationMode !== 'tauri') {
        notify(t('browserDemoMode'), t('startDesktopAppPublishReal_46c2'), 'warning')
        return
      }
      const normalizedServerUrl = targetServerUrl.trim().replace(/\/+$/, '')
      const normalizedName = repositoryName.trim()
      const repositoryUrl = `${normalizedServerUrl}/${normalizedName}`
      if (
        !confirmLocalized(
          t('confirm.publishCreateAndPush', {
            server: repositoryUrl,
            branch: activeSnapshot.repository.branch
          })
        )
      ) {
        return
      }
      await runRepositoryMutation(
        'publishRepository',
        async (repository) => {
          const existingAccount = resolvePublishAuthAccount(repository.path, authAccountBindings, [])
          const selectedUserId = authUserId?.trim()
          const selectedIdentity = selectedUserId
            ? publishAuthIdentities.find((candidate) => candidate.userId.trim() === selectedUserId)
            : undefined
          if (selectedUserId && existingAccount?.userId !== selectedUserId && !selectedIdentity) {
            throw new Error(t('accountUnavailable'))
          }

          if (selectedUserId && existingAccount?.userId !== selectedUserId && selectedIdentity) {
            /*
             * 显式选择的账户同时成为仓库绑定，使本次发布后的普通 Push、Sync 和远端
             * 目录读取继续使用同一 Token Store 身份。留空只影响本次发布，不会暗中
             * 删除用户在账户页维护的既有绑定。
             */
            await setRepositoryAuthAccountBinding(repository.path, selectedUserId)
            const nextBindings = authAccountBindings.filter(
              (binding) => binding.repositoryPath.toLocaleLowerCase() !== repository.path.toLocaleLowerCase()
            )
            nextBindings.push({
              repositoryPath: repository.path,
              authUrl: selectedIdentity.authUrl,
              userId: selectedUserId
            })
            onAuthAccountBindingsChange(nextBindings)
          }

          const publish = () =>
            publishRepository(
              repository.path,
              normalizedName,
              description,
              identity,
              defaultIdentity,
              normalizedServerUrl,
              repository.branch,
              selectedUserId
            )
          try {
            return await publish()
          } catch (error) {
            if (!selectedUserId || !isPublishAuthenticationError(error)) {
              throw error
            }
            /*
             * 与服务器目录的 MissingToken 流程保持一致：选中账户的缓存凭据过期或
             * 不再有效时，交给 Lore 打开系统浏览器更新 Token Store，然后自动重试
             * 同一个尚未完成 Create 的发布请求。第二次失败会原样进入完整错误反馈。
             */
            await loginAuthInteractive(normalizedServerUrl)
            const refreshedIdentities = await listAuthIdentities()
            setPublishAuthIdentities(refreshedIdentities)
            return publish()
          }
        },
        operationMessage('status.repositoryPublishedAndPushed', {
          url: repositoryUrl,
          branch: activeSnapshot.repository.branch
        })
      )
    },
    [
      activeSnapshot,
      applicationMode,
      authAccountBindings,
      defaultIdentity,
      notify,
      onAuthAccountBindingsChange,
      publishAuthIdentities,
      runRepositoryMutation
    ]
  )

  /** 账户是设备级资源；登录、退出和列表不得要求先打开本地仓库。 */
  const runAuthAction = useCallback(
    async (action: () => Promise<unknown>): Promise<boolean> => {
      if (applicationMode !== 'tauri') return false
      try {
        setLoading(true)
        await action()
        return true
      } catch (error) {
        notify(t('accountOperationFailed'), readErrorMessage(error), 'warning')
        return false
      } finally {
        setLoading(false)
      }
    },
    [applicationMode, notify]
  )

  const dialogProps = useMemo<RepositoryToolsDialogProps | null>(() => {
    if (!tab || (!activeSnapshot && tab !== 'accounts')) return null
    const repository = activeSnapshot?.repository ?? {
      id: 'device-accounts',
      name: t('accounts'),
      branch: t('noWorkspaceOpen'),
      revision: '',
      path: '',
      ahead: 0,
      behind: 0,
      online: false,
      color: '#78a4ff',
      conflictCount: 0,
      unresolvedConflictCount: 0
    }
    return {
      tab,
      repository,
      branches: activeSnapshot?.branches ?? [],
      revisions: activeSnapshot?.revisions ?? [],
      defaultIdentity,
      layers,
      links,
      locks: fileLocks,
      dependencyQuery,
      loading: loading || isRepositoryToolsBusy(busyAction),
      compositionAvailable: applicationMode === 'tauri',
      lockAvailable: applicationMode === 'tauri',
      dependencyAvailable: applicationMode === 'tauri',
      publishAvailable: applicationMode === 'tauri',
      connectedRemoteDescription,
      connectedRemoteName,
      publishAuthIdentities,
      repositoryView,
      currentRevisionId: repository.revision || undefined,
      viewBlockedReason: activeSnapshot?.conflictSession
        ? t('finishConflictBeforeApplyingView')
        : activeSnapshot?.changes.length
          ? t('cleanWorkspaceBeforeApplyingView')
          : undefined,
      onTabChange: (nextTab) => void open(nextTab),
      onRefresh: () => void open(tab),
      onSaveConfiguration: (identity, remoteUrl) => void saveRepositoryConfiguration(identity, remoteUrl),
      onPublish: (identity, serverUrl, repositoryName, description, authUserId) =>
        void publishActiveRepository(identity, serverUrl, repositoryName, description, authUserId),
      onPushCurrentBranch: () => void pushCurrentRepository(),
      onPreviewView: previewActiveRepositoryView,
      onApplyView: applyActiveRepositoryView,
      onAddLayer: addActiveLayer,
      onRemoveLayer: removeActiveLayer,
      onAddLink: addActiveLink,
      onUpdateLink: updateActiveLink,
      onRemoveLink: removeActiveLink,
      onAcquireLock: (path) => acquireActiveFileLocks([path]),
      onReleaseLock: (path) => releaseActiveFileLocks([path]),
      onQueryDependencies: queryActiveDependencies,
      onAddDependency: (sourcePath, dependencyPath, tags, force) =>
        runRepositoryMutation(
          'addFileDependency',
          (targetRepository) => addFileDependency(targetRepository.path, sourcePath, dependencyPath, tags, force),
          operationMessage('status.fileDependencyAdded', {
            source: sourcePath,
            dependency: dependencyPath
          })
        ),
      onRemoveDependency: (sourcePath, dependencyPath, tags) =>
        runRepositoryMutation(
          'removeFileDependency',
          (targetRepository) => removeFileDependency(targetRepository.path, sourcePath, dependencyPath, tags),
          operationMessage('status.fileDependencyRemoved', {
            source: sourcePath,
            dependency: dependencyPath
          })
        ),
      onDependencySync: (options) =>
        runRepositoryMutation(
          'dependencyDrivenSync',
          (targetRepository) => syncRepository(targetRepository.path, options),
          operationMessage('status.dependencyDrivenSyncCompleted', {
            count: options.rootFiles.length
          })
        ),
      onLoadBranchCollaboration: (branch) => loadBranchCollaboration(repository.path, branch),
      onLoadBranchDiff: (source, target, path) => loadBranchDiff(repository.path, source, target, path),
      onSetBranchProtected: setActiveBranchProtected,
      onResetBranchLatest: resetActiveBranchLatest,
      onLoadRevisionInfo: (revision) => loadRevisionInfo(repository.path, revision),
      onFindRevisionNumber: (number) => findRevisionByNumber(repository.path, number),
      onFindRevisionMetadata: (key, value) => findRevisionByMetadata(repository.path, key, value),
      onAmendRevision: amendActiveRevision,
      onBisectRevision: bisectActiveRevision,
      onRestoreRevision: restoreActiveRevision,
      onLocateRevision: (revision) => {
        locateRevision(revision)
        close()
      },
      onListAuthIdentities: () => listAuthIdentities(),
      accountRepositories: repositorySnapshots.map((snapshot) => snapshot.repository),
      authAccountBindings,
      onSetAuthAccountBinding: async (targetRepository, identity) => {
        try {
          setLoading(true)
          await setRepositoryAuthAccountBinding(targetRepository.path, identity?.userId)
          const nextBindings = authAccountBindings.filter(
            (binding) => binding.repositoryPath.toLocaleLowerCase() !== targetRepository.path.toLocaleLowerCase()
          )
          if (identity) {
            nextBindings.push({
              repositoryPath: targetRepository.path,
              authUrl: identity.authUrl,
              userId: identity.userId
            })
          }
          onAuthAccountBindingsChange(nextBindings)
          return true
        } catch (error) {
          notify(t('unableToUpdateRepositoryAccount'), readErrorMessage(error), 'warning')
          return false
        } finally {
          setLoading(false)
        }
      },
      onLoginAuthInteractive: (remoteUrl) => runAuthAction(() => loginAuthInteractive(remoteUrl)),
      onLoginAuthWithToken: (remoteUrl, token, tokenType, authUrl) =>
        runAuthAction(() => loginAuthWithToken(remoteUrl, token, tokenType, authUrl)),
      onLogoutAuthIdentity: (identity) => {
        if (
          !confirmLocalized(
            t('confirm.logoutAuthIdentity', {
              user: identity.userId,
              url: identity.authUrl
            })
          )
        ) {
          return Promise.resolve(false)
        }
        return runAuthAction(() => logoutAuthIdentity(identity.authUrl, identity.userId))
      },
      onClearAuthIdentities: () => {
        if (!confirmLocalized(t('confirm.clearAuthIdentities'))) return Promise.resolve(false)
        return runAuthAction(() => clearAuthIdentities())
      },
      onLoadMetadata: (scope, target, revision) => loadMetadata(repository.path, scope, target, revision),
      onVerifyPath: async (path, heal) => {
        if (!heal) return verifyRepositoryPath(repository.path, path, false)
        let report: LoreDiagnosticReport | null = null
        const succeeded = await runRepositoryMutation(
          'healRepository',
          async (targetRepository) => {
            report = await verifyRepositoryPath(targetRepository.path, path, true)
          },
          operationMessage('status.repositoryPathHealed', {
            path: path || t('entireRepository')
          })
        )
        if (!succeeded || !report) throw new Error(t('repositoryHealDidNotComplete'))
        return report
      },
      onVerifyFragment: (hash, context, heal) => verifyRepositoryFragment(repository.path, hash, context, heal),
      onDumpRepository: (revision, path, maxDepth) => dumpRepositoryState(repository.path, revision, path, maxDepth),
      onListInstances: () => listRepositoryInstances(repository.path),
      onPruneInstances: () =>
        runRepositoryMutation(
          'pruneRepositoryInstances',
          (targetRepository) => pruneRepositoryInstances(targetRepository.path),
          operationMessage('status.staleInstancesPruned')
        ),
      onUpdateInstancePath: () =>
        runRepositoryMutation(
          'updateRepositoryInstancePath',
          (targetRepository) => updateRepositoryInstancePath(targetRepository.path),
          operationMessage('status.instancePathUpdated')
        ),
      onVerify: () => {
        void runRepositoryMutation(
          'verifyRepository',
          (targetRepository) => verifyRepository(targetRepository.path),
          operationMessage('loreCoreFinishedReadConsistency_86d2')
        )
      },
      onCollectGarbage: () => {
        if (!confirmLocalized(t('confirm.runGc'))) return
        void runRepositoryMutation(
          'collectStorage',
          (targetRepository) => collectRepositoryGarbage(targetRepository.path),
          operationMessage('loreCoreFinishedCollectingUnreferencedContent')
        )
      },
      onClose: close
    }
  }, [
    activeSnapshot,
    authAccountBindings,
    addActiveLayer,
    addActiveLink,
    amendActiveRevision,
    applicationMode,
    applyActiveRepositoryView,
    acquireActiveFileLocks,
    bisectActiveRevision,
    busyAction,
    close,
    connectedRemoteDescription,
    connectedRemoteName,
    defaultIdentity,
    dependencyQuery,
    fileLocks,
    layers,
    links,
    loading,
    locateRevision,
    notify,
    onAuthAccountBindingsChange,
    open,
    previewActiveRepositoryView,
    publishActiveRepository,
    publishAuthIdentities,
    pushCurrentRepository,
    queryActiveDependencies,
    releaseActiveFileLocks,
    removeActiveLayer,
    removeActiveLink,
    resetActiveBranchLatest,
    restoreActiveRevision,
    repositoryView,
    repositorySnapshots,
    runAuthAction,
    runRepositoryMutation,
    saveRepositoryConfiguration,
    setActiveBranchProtected,
    tab,
    updateActiveLink
  ])

  return {
    dialogProps,
    fileLocks,
    fileLockState,
    open,
    close,
    acquireFileLocks: acquireActiveFileLocks,
    releaseFileLocks: releaseActiveFileLocks
  }
}
