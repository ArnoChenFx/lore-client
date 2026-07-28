import { useCallback, useEffect, useRef, useState } from 'react'

import { t } from '../../i18n'
import {
  cloneRepository,
  DEFAULT_SERVER_URL,
  initializeRepository,
  isAuthenticationRequiredError,
  listAuthIdentities,
  listRemoteRepositories,
  loadRemoteRepositoryInfo,
  loadRepositorySnapshot,
  loginAuthInteractive,
  probeRepositoryDirectory,
  selectCloneParentDirectory,
  selectCloneViewFile,
  selectRepositoryDirectory
} from '../../services/lore'
import { readErrorMessage } from '../../shared/lib'
import type {
  ApplicationMode,
  LoreCloneOptions,
  LoreAuthIdentity,
  LoreSharedStoreInfo,
  NavigationView,
  OperationDetail,
  RemoteRepository,
  RepositorySnapshot
} from '../../types'
import { operationMessage, type ActiveOperation } from '../operations'
import type { AppNotify } from './controllerTypes'

type BeginOperation = (labelKey: string, detail: string | OperationDetail) => ActiveOperation
type FinishOperation = (operation: ActiveOperation, succeeded: boolean, detail: string | OperationDetail) => void

interface UseRepositoryEntryControllerOptions {
  applicationMode: ApplicationMode
  defaultIdentity: string
  sharedStoreInfo: LoreSharedStoreInfo | null
  activateRepositorySnapshot: (snapshot: RepositorySnapshot) => void
  upsertSnapshot: (snapshot: RepositorySnapshot) => void
  setActiveView: (view: NavigationView) => void
  setServerDialogOpen: (open: boolean) => void
  tryBeginRepositoryMutation: () => boolean
  finishRepositoryMutation: () => void
  beginOperation: BeginOperation
  finishOperation: FinishOperation
  refreshSharedStores: () => Promise<void>
  notify: AppNotify
  serverDialogOpen: boolean
  authStateVersion: number
  onAuthenticationRequired: (serverUrl: string) => void
  onAuthStateChange: (serverUrl?: string) => Promise<unknown>
}

/**
 * 管理“打开目录 → 初始化仓库”以及“浏览服务器 → Clone”的入口流程。
 *
 * 这些状态在初始化、服务器和 Clone 弹层之间共享，但不会影响已打开仓库的工作区；
 * 因此由仓库入口控制器持有，App 只消费语义动作和已经组装好的弹层属性。
 */
export function useRepositoryEntryController({
  applicationMode,
  defaultIdentity,
  sharedStoreInfo,
  activateRepositorySnapshot,
  upsertSnapshot,
  setActiveView,
  setServerDialogOpen,
  tryBeginRepositoryMutation,
  finishRepositoryMutation,
  beginOperation,
  finishOperation,
  refreshSharedStores,
  notify,
  serverDialogOpen,
  authStateVersion,
  onAuthenticationRequired,
  onAuthStateChange
}: UseRepositoryEntryControllerOptions) {
  const [remoteBrowserUrl, setRemoteBrowserUrl] = useState(DEFAULT_SERVER_URL)
  const [remoteRepositories, setRemoteRepositories] = useState<RemoteRepository[]>([])
  const [serverLoading, setServerLoading] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [serverAuthIdentities, setServerAuthIdentities] = useState<LoreAuthIdentity[]>([])
  const [serverAuthUserId, setServerAuthUserId] = useState('')
  const [selectedRemote, setSelectedRemote] = useState<RemoteRepository | null>(null)
  const [cloneBusy, setCloneBusy] = useState(false)
  const [initializationTarget, setInitializationTarget] = useState<string | null>(null)
  const [initializationBusy, setInitializationBusy] = useState(false)
  const [initializationError, setInitializationError] = useState<string | null>(null)
  // 打开、初始化与其他仓库写操作共享同一语义 Busy 状态，避免窗口外壳维护领域过程状态。
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const observedAuthStateVersion = useRef(authStateVersion)

  /** 激活仓库时只同步服务器浏览的建议起点，不把临时草稿写回仓库配置。 */
  const activateSnapshot = useCallback(
    (snapshot: RepositorySnapshot) => {
      activateRepositorySnapshot(snapshot)
      setRemoteBrowserUrl(snapshot.repository.serverUrl ?? DEFAULT_SERVER_URL)
    },
    [activateRepositorySnapshot]
  )

  const openRepository = useCallback(async () => {
    if (applicationMode === 'browser-demo') {
      notify(t('browserDemoMode'), t('directorySelectionRealLoreCalls_e03f'), 'warning')
      return
    }

    try {
      const repositoryPath = await selectRepositoryDirectory()
      if (!repositoryPath) return

      setBusyAction('checkingDirectory')
      const probe = await probeRepositoryDirectory(repositoryPath)
      if (probe.kind === 'unmanaged') {
        setInitializationError(null)
        setInitializationTarget(probe.selectedPath)
        return
      }
      if (!probe.repositoryPath) {
        throw new Error(t('directoryProbeResultMissingLore_99b0'))
      }

      setBusyAction('openingRepository')
      const snapshot = await loadRepositorySnapshot(probe.repositoryPath, true)
      upsertSnapshot(snapshot)
      activateSnapshot(snapshot)
      setActiveView('history')
    } catch (error) {
      notify(t('unableToOpenProjectDirectory'), readErrorMessage(error), 'warning')
    } finally {
      setBusyAction(null)
    }
  }, [activateSnapshot, applicationMode, notify, setActiveView, setBusyAction, upsertSnapshot])

  /** 普通目录初始化成功后立即扫描已有文件，并把新仓库加入项目标签会话。 */
  const performRepositoryInitialization = useCallback(
    async (repositoryName: string, description: string, repositoryIdentity: string) => {
      if (!initializationTarget) return
      if (applicationMode !== 'tauri') {
        notify(t('browserDemoMode'), t('startDesktopAppInitializeReal_76f2'), 'warning')
        return
      }
      if (!tryBeginRepositoryMutation()) {
        notify(t('repositoryOperationInProgress'), t('waitCurrentLoreCommandFinish_423b'), 'warning')
        return
      }

      const operation = beginOperation('initializeLoreRepository', initializationTarget)
      try {
        setInitializationBusy(true)
        setInitializationError(null)
        setBusyAction('initializingLoreRepository')
        const initialized = await initializeRepository(
          initializationTarget,
          repositoryName,
          description,
          repositoryIdentity,
          defaultIdentity
        )

        /*
         * Create 已成功后必须先关闭表单。若首次读取失败仍保留表单，用户重试只会得到
         * RepositoryAlreadyExists，反而掩盖仓库已经创建成功的事实。
         */
        setInitializationTarget(null)
        try {
          const snapshot = await loadRepositorySnapshot(initialized.repositoryPath, true)
          upsertSnapshot(snapshot)
          activateSnapshot(snapshot)
          setActiveView('changes')
          finishOperation(
            operation,
            true,
            operationMessage('status.initializedAndScanned', {
              name: snapshot.repository.name,
              count: snapshot.changes.length
            })
          )
          notify(
            t('loreRepositoryInitialized'),
            t('status.nameWithLocalChanges', {
              name: snapshot.repository.name,
              count: snapshot.changes.length
            }),
            'success'
          )
        } catch (error) {
          const message = readErrorMessage(error)
          finishOperation(
            operation,
            true,
            operationMessage('status.initializedButFirstReadFailed', {
              message
            })
          )
          notify(t('repositoryInitializedButCouldOpened_42c6'), `${initialized.repositoryPath}: ${message}`, 'warning')
        }
      } catch (error) {
        const message = readErrorMessage(error)
        setInitializationError(message)
        finishOperation(operation, false, message)
        notify(t('failedToInitializeLoreRepository'), message, 'warning')
      } finally {
        finishRepositoryMutation()
        setInitializationBusy(false)
        setBusyAction(null)
      }
    },
    [
      activateSnapshot,
      applicationMode,
      beginOperation,
      defaultIdentity,
      finishOperation,
      finishRepositoryMutation,
      initializationTarget,
      notify,
      setActiveView,
      setBusyAction,
      tryBeginRepositoryMutation,
      upsertSnapshot
    ]
  )

  /** 打开服务器面板，并通过 Lore 协议执行一次只读目录刷新。 */
  const refreshServerRepositories = useCallback(async () => {
    setServerDialogOpen(true)
    if (applicationMode !== 'tauri') {
      setServerError(t('browserDemoModeOpenLore_4a2a'))
      return
    }

    const operation = beginOperation('loadRemoteRepositories', remoteBrowserUrl)
    try {
      setServerLoading(true)
      setServerError(null)
      const identities = await listAuthIdentities()
      setServerAuthIdentities(identities)
      const repositories = await listRemoteRepositories(remoteBrowserUrl, serverAuthUserId)
      setRemoteRepositories(repositories)
      finishOperation(
        operation,
        true,
        operationMessage('status.repositoriesLoaded', {
          count: repositories.length
        })
      )
    } catch (error) {
      /* MissingToken 交给全局恢复弹层，让用户可以重新认证或明确回到离线模式。 */
      if (isAuthenticationRequiredError(error)) {
        setRemoteRepositories([])
        setServerError(t('remoteAuthenticationRequired'))
        onAuthenticationRequired(remoteBrowserUrl)
        finishOperation(operation, false, operationMessage('remoteAuthenticationRequired'))
        return
      }
      setRemoteRepositories([])
      const message = readErrorMessage(error)
      setServerError(message)
      finishOperation(operation, false, message)
    } finally {
      setServerLoading(false)
    }
  }, [
    applicationMode,
    beginOperation,
    finishOperation,
    onAuthenticationRequired,
    remoteBrowserUrl,
    serverAuthUserId,
    setServerDialogOpen
  ])

  /** 用户可显式更新当前服务器凭据；完成后自动刷新目录。 */
  const authenticateServer = useCallback(async () => {
    if (applicationMode !== 'tauri' || serverLoading || !remoteBrowserUrl.trim()) return
    try {
      setServerLoading(true)
      setServerError(null)
      await loginAuthInteractive(remoteBrowserUrl)
      setServerAuthIdentities(await listAuthIdentities())
      setServerAuthUserId('')
      setRemoteRepositories(await listRemoteRepositories(remoteBrowserUrl))
      await onAuthStateChange(remoteBrowserUrl)
    } catch (error) {
      setRemoteRepositories([])
      if (isAuthenticationRequiredError(error)) onAuthenticationRequired(remoteBrowserUrl)
      setServerError(readErrorMessage(error))
    } finally {
      setServerLoading(false)
    }
  }, [applicationMode, onAuthenticationRequired, onAuthStateChange, remoteBrowserUrl, serverLoading])

  /*
   * 认证可能从全局恢复弹层或账户中心完成。服务器目录保持打开时自动重读账户与目录，
   * 让同一应用会话中的所有认证入口立即收敛，不要求用户再次点击刷新。
   */
  useEffect(() => {
    if (authStateVersion === observedAuthStateVersion.current) return
    if (!serverDialogOpen || applicationMode !== 'tauri') {
      observedAuthStateVersion.current = authStateVersion
      return
    }
    /* 忙碌时不吞掉版本变化；loading 结束后 effect 会再次执行并完成刷新。 */
    if (serverLoading) return
    observedAuthStateVersion.current = authStateVersion
    void (async () => {
      try {
        setServerLoading(true)
        setServerAuthIdentities(await listAuthIdentities())
        setServerAuthUserId('')
        setRemoteRepositories(await listRemoteRepositories(remoteBrowserUrl))
        setServerError(null)
      } catch (error) {
        if (isAuthenticationRequiredError(error)) {
          setServerError(t('remoteAuthenticationRequired'))
          onAuthenticationRequired(remoteBrowserUrl)
        } else {
          setServerError(readErrorMessage(error))
        }
      } finally {
        setServerLoading(false)
      }
    })()
  }, [applicationMode, authStateVersion, onAuthenticationRequired, remoteBrowserUrl, serverDialogOpen, serverLoading])

  /** Clone 弹层打开前读取远端详情，并同步刷新可选 Shared Store。 */
  const prepareRemoteClone = useCallback(
    async (repository: RemoteRepository) => {
      if (applicationMode !== 'tauri') {
        setSelectedRemote(repository)
        void refreshSharedStores()
        return
      }
      const operation = beginOperation('loadRemoteRepositoryInfo', repository.name)
      try {
        setServerLoading(true)
        const details = await loadRemoteRepositoryInfo(remoteBrowserUrl, repository.name, serverAuthUserId)
        setSelectedRemote({ ...repository, ...details })
        void refreshSharedStores()
        finishOperation(operation, true, details.defaultBranch || details.name)
      } catch (error) {
        if (isAuthenticationRequiredError(error)) onAuthenticationRequired(remoteBrowserUrl)
        const message = readErrorMessage(error)
        finishOperation(operation, false, message)
        notify(t('unableToLoadRemoteRepositoryDetails'), message, 'warning')
      } finally {
        setServerLoading(false)
      }
    },
    [
      applicationMode,
      beginOperation,
      finishOperation,
      notify,
      onAuthenticationRequired,
      refreshSharedStores,
      remoteBrowserUrl,
      serverAuthUserId
    ]
  )

  const performClone = useCallback(
    async (parent: string, directoryName: string, viewPath: string, options: LoreCloneOptions) => {
      if (!selectedRemote) return
      if (applicationMode !== 'tauri') {
        notify(t('browserDemoMode'), t('startDesktopAppPerformReal_9915'), 'warning')
        return
      }
      const operation = beginOperation('cloneRemoteRepository', selectedRemote.name)
      try {
        setCloneBusy(true)
        const clone = await cloneRepository(
          remoteBrowserUrl,
          selectedRemote.name,
          parent,
          directoryName,
          viewPath,
          options,
          serverAuthUserId
        )
        const snapshot = await loadRepositorySnapshot(clone.destinationPath, true)
        upsertSnapshot(snapshot)
        activateSnapshot(snapshot)
        setSelectedRemote(null)
        setServerDialogOpen(false)
        setActiveView('history')
        finishOperation(operation, true, clone.destinationPath)
        notify(t('repositoryCloned'), clone.destinationPath, 'success')
      } catch (error) {
        if (isAuthenticationRequiredError(error)) onAuthenticationRequired(remoteBrowserUrl)
        const message = readErrorMessage(error)
        finishOperation(operation, false, message)
        notify(t('repositoryCloneFailed'), message, 'warning')
      } finally {
        setCloneBusy(false)
      }
    },
    [
      activateSnapshot,
      applicationMode,
      beginOperation,
      finishOperation,
      notify,
      onAuthenticationRequired,
      remoteBrowserUrl,
      selectedRemote,
      serverAuthUserId,
      setActiveView,
      setServerDialogOpen,
      upsertSnapshot
    ]
  )

  return {
    busyAction,
    setBusyAction,
    activateSnapshot,
    openRepository,
    openServer: refreshServerRepositories,
    initializationDialog: initializationTarget
      ? {
          directoryPath: initializationTarget,
          defaultIdentity,
          busy: initializationBusy,
          error: initializationError,
          onConfirm: (repositoryName: string, description: string, repositoryIdentity: string) =>
            void performRepositoryInitialization(repositoryName, description, repositoryIdentity),
          onClose: () => {
            if (!initializationBusy) {
              setInitializationTarget(null)
              setInitializationError(null)
            }
          }
        }
      : null,
    serverDialog: {
      browserServerUrl: remoteBrowserUrl,
      repositories: remoteRepositories,
      loading: serverLoading,
      error: serverError,
      identities: serverAuthIdentities,
      selectedUserId: serverAuthUserId,
      onBrowserServerUrlChange: setRemoteBrowserUrl,
      onSelectedUserIdChange: setServerAuthUserId,
      onAuthenticate: () => void authenticateServer(),
      onRefresh: () => void refreshServerRepositories(),
      onClone: (repository: RemoteRepository) => void prepareRemoteClone(repository),
      onClose: () => setServerDialogOpen(false)
    },
    cloneDialog: selectedRemote
      ? {
          repository: selectedRemote,
          serverUrl: remoteBrowserUrl,
          sharedStoreInfo,
          busy: cloneBusy,
          onChooseParent: selectCloneParentDirectory,
          onChooseView: selectCloneViewFile,
          onConfirm: (parent: string, directoryName: string, viewPath: string, options: LoreCloneOptions) =>
            void performClone(parent, directoryName, viewPath, options),
          onClose: () => {
            if (!cloneBusy) setSelectedRemote(null)
          }
        }
      : null
  }
}
