import { useCallback, useEffect, useMemo, useRef } from 'react'

import {
  AppGlobalOverlays,
  AppRepositoryOverlays,
  AppShell,
  AppWorkspace,
  Sidebar,
  type AppUpdateState,
  createPlaceholderRepository,
  useAppFeedback,
  useAppUpdater,
  useAppOverlayState,
  useAppToolbarActions,
  useAppWorkspaceNavigation,
  useAppVersionActions
} from './app/index'
import {
  browserDependencyGraphFixture,
  browserUpdateDialogFixture,
  branches as demoBranches,
  getDemoInspectorFiles,
  initialChanges as demoChanges,
  inspectorFiles as demoInspectorFiles,
  repositories as demoRepositories,
  revisions as demoRevisions,
  shouldUseBrowserDependencyGraphFixture,
  shouldUseBrowserRemoteAuthenticationFixture,
  shouldUseBrowserUpdateDialogFixture,
  tags as demoTags
} from './demo'
import { BranchOverview } from './features/branches'
import { useAvailableExternalTools } from './features/external-tools'
import {
  LocalChanges,
  WorkingTreeDiffContainer,
  useLocalChangeActions,
  useLocalChangeSelection,
  useLocalChangesAutoRefresh
} from './features/local-changes'
import { operationMessage, useOperationHistory } from './features/operations'
import {
  RepositoryWelcome,
  conflictOperationLabel,
  runRepositoryMutationLifecycle,
  useRepositoryEntryController,
  useRepositoryRefresh,
  useRemoteAuthenticationRecovery,
  useRepositorySession,
  useRepositorySessionLifecycle,
  repositorySessionKey,
  useSharedStoreController
} from './features/repository-session'
import { useRepositoryToolsController } from './features/repository-tools'
import {
  HistoryPanelContainer,
  Inspector,
  useRevisionFileActions,
  useRevisionInspectorData
} from './features/revision-inspector'
import { TagOverview } from './features/tags'
import { useClientPreferences } from './hooks/useClientPreferences'
import { useTheme } from './hooks/useTheme'
import { useWorkspaceLayout } from './hooks/useWorkspaceLayout'
import { setAppLanguage, confirmLocalized, t } from './i18n'
import {
  DEFAULT_SERVER_URL,
  getApplicationMode,
  loadBinaryFilePreview,
  loadRepositorySnapshot,
  pushBranch,
  openExternalDiff,
  selectExternalDiffExecutable
} from './services/lore'
import { changeDirectoryPathFromObjectId, changeFileObjectId, changeFilePath, readErrorMessage } from './shared/lib'
import { PaneResizer } from './shared/ui'
import type { BinaryFilePreview, NavigationView, OperationDetail, Repository, RepositorySnapshot } from './types'

const applicationMode = getApplicationMode()
const dependencyGraphFixtureEnabled = shouldUseBrowserDependencyGraphFixture(applicationMode)
const remoteAuthenticationFixtureEnabled = shouldUseBrowserRemoteAuthenticationFixture(applicationMode)
const updateDialogFixtureEnabled = shouldUseBrowserUpdateDialogFixture(applicationMode)

const browserDemoSnapshots: RepositorySnapshot[] = demoRepositories.map((repository, index) => ({
  repository:
    remoteAuthenticationFixtureEnabled && index < 2
      ? {
          ...repository,
          online: false,
          remoteState: 'unauthorized',
          remoteUrl: `lore://127.0.0.1:41337/${repository.name}`,
          serverUrl: 'lore://127.0.0.1:41337'
        }
      : repository,
  branches: demoBranches,
  revisions: demoRevisions,
  changes: demoChanges,
  tags: demoTags,
  conflictSession: null,
  loadedAt: new Date().toISOString()
}))

function App() {
  const {
    preferences,
    ready: preferencesReady,
    error: preferencesError,
    update: updatePreferences
  } = useClientPreferences()

  /*
   * 语言切换必须在副作用中执行，不能在渲染期间调用，否则会触发
   * "Cannot update a component while rendering" 警告。
   */
  useEffect(() => {
    setAppLanguage(preferences.language)
    if (typeof document !== 'undefined') {
      document.documentElement.lang = preferences.language
    }
  }, [preferences.language])
  const { preference, resolvedTheme, setPreference, toggleTheme } = useTheme()
  const { layout, resizeSidebar, resizeInspector, resetLayout } = useWorkspaceLayout()
  // 浏览器演示与 Vite 开发构建没有正式签名公钥和发布端点，不执行无意义的更新请求。
  const appUpdater = useAppUpdater(
    applicationMode === 'tauri' && import.meta.env.PROD,
    preferencesReady && preferences.automaticallyCheckForUpdates
  )
  const updateState: AppUpdateState = updateDialogFixtureEnabled ? browserUpdateDialogFixture : appUpdater.state
  const {
    snapshots: sessionSnapshots,
    activeRepositoryId,
    selectedRevisionId,
    selectedBranchId,
    selectedTagId,
    unavailableRepositoryPaths,
    setSelectedRevisionId,
    setSelectedBranchId,
    setSelectedTagId,
    activateRepositorySnapshot,
    upsertSnapshot,
    reorderRepositoryTabs,
    replaceRepositorySession,
    removeRepositorySnapshot
  } = useRepositorySession(applicationMode === 'browser-demo' ? browserDemoSnapshots : [], {
    revisionId: demoRevisions[0]?.id,
    branchId: demoBranches.find((branch) => branch.current)?.id ?? demoBranches[0]?.id,
    tagId: demoTags[0]?.id
  })
  const {
    commandPaletteOpen,
    serverDialogOpen,
    settingsOpen,
    settingsInitialCategory,
    updateDialogOpen,
    searchOpen,
    operationsOpen,
    aboutOpen,
    setCommandPaletteOpen,
    setServerDialogOpen,
    setSettingsOpen,
    setSettingsInitialCategory,
    setUpdateDialogOpen,
    setSearchOpen,
    setOperationsOpen,
    setAboutOpen,
    showUpdate
  } = useAppOverlayState()
  const {
    activeView,
    setActiveView,
    inspectorTab,
    setInspectorTab,
    revisionRevealRequest,
    revealRevision,
    handleSearchResult
  } = useAppWorkspaceNavigation({
    preferredInspectorTab: preferences.inspectorTab,
    preferencesReady,
    onInspectorTabPreferenceChange: (inspectorTab) => updatePreferences({ inspectorTab }),
    onRevisionSelect: setSelectedRevisionId,
    onBranchSelect: setSelectedBranchId
  })
  const { toast, runtimeInfo, notify, closeToast } = useAppFeedback({
    updateState,
    preferencesError,
    showUpdate
  })
  const enterOfflineMode = useCallback(() => setServerDialogOpen(false), [setServerDialogOpen])
  const remoteAuthentication = useRemoteAuthenticationRecovery({
    applicationMode,
    snapshots: sessionSnapshots,
    upsertSnapshot,
    onEnterOfflineMode: enterOfflineMode
  })
  /*
   * 会话仍保存 Lore 返回的原始认证状态；所有界面统一消费离线投影，确保用户跳过后
   * 标题栏、工具栏、状态栏与仓库工具不会显示互相冲突的连接状态。
   */
  const snapshots = remoteAuthentication.snapshots
  const {
    operations,
    loreOperationStreams,
    activeCount: activeOperationCount,
    beginOperation,
    finishOperation,
    clearCompleted: clearCompletedOperations
  } = useOperationHistory(applicationMode === 'tauri')
  const { availableExternalToolIds, availableExternalDiffTools, availableExternalMergeTools } =
    useAvailableExternalTools(preferences)
  const workspaceRef = useRef<HTMLElement>(null)
  const activeSnapshot =
    snapshots.find((snapshot) => repositorySessionKey(snapshot) === activeRepositoryId) ?? snapshots[0]
  const activeRepositoryPath = activeSnapshot?.repository.path ?? ''
  const notifyRepositoryRefreshError = useCallback(
    (error: unknown) => notify(t('unableToRefreshLocalChanges'), readErrorMessage(error), 'warning'),
    [notify]
  )
  const {
    refreshingRepositoryPaths,
    refreshActiveRepositorySnapshot,
    tryBeginRepositoryMutation,
    finishRepositoryMutation
  } = useRepositoryRefresh({
    enabled: applicationMode === 'tauri',
    networkEnabled: !activeSnapshot || !remoteAuthentication.isRepositoryNetworkPaused(activeSnapshot.repository),
    repositoryPath: activeRepositoryPath,
    remoteState: activeSnapshot?.repository.remoteState ?? 'local',
    upsertSnapshot,
    onRefreshError: notifyRepositoryRefreshError
  })
  useLocalChangesAutoRefresh({
    applicationMode,
    activeView,
    repositoryPath: activeRepositoryPath,
    refresh: refreshActiveRepositorySnapshot
  })
  const activeRepository = activeSnapshot?.repository ?? createPlaceholderRepository()
  const selectedRevision =
    activeSnapshot?.revisions.find((revision) => revision.id === selectedRevisionId) ??
    activeSnapshot?.revisions.find((revision) => revision.id === activeSnapshot.repository.revision) ??
    activeSnapshot?.revisions[0] ??
    null
  const { selectedChangeIds, primaryChangeId, selectedChange, selectedChangeFolder, selectChangeFiles } =
    useLocalChangeSelection(activeSnapshot?.changes)
  const currentRevisionId = activeSnapshot?.repository.revision
  /*
   * 本地更改允许完全收起最右侧 Diff；其他一级视图仍需要 Revision Inspector，
   * 因此这里只在本地更改页根据独立偏好缩减外层工作区列数。
   */
  const workspaceInspectorVisible = activeView !== 'changes' || preferences.localChangesDiffVisible
  const loadActiveRepositoryBinaryPreview = useCallback(
    (path: string, revision?: string, metadataOnly = false): Promise<BinaryFilePreview> =>
      loadBinaryFilePreview(activeRepository.path, path, revision, metadataOnly, preferences.binaryPreviewLimitMib),
    [activeRepository.path, preferences.binaryPreviewLimitMib]
  )
  const demoRevisionFiles = useMemo(() => {
    if (!selectedRevision || !activeSnapshot) {
      return []
    }
    if (applicationMode === 'browser-demo') {
      return getDemoInspectorFiles(selectedRevision, demoInspectorFiles)
    }
    return []
  }, [activeSnapshot, selectedRevision])
  const {
    visibleInspectorFiles,
    visibleRevisionFiles,
    revisionTreeReady,
    inspectorRevision,
    revisionChangesRevisionId,
    revisionChangesLoading,
    revisionChangesError,
    revisionDiffSource,
    revisionDiffs,
    revisionDiffLoading,
    revisionDiffError,
    revisionDiffNotice,
    revisionFilesLoading,
    revisionFilesError,
    selectRevisionPrimaryChange,
    selectRevisionDiffSource
  } = useRevisionInspectorData({
    applicationMode,
    repositoryPath: activeRepository.path,
    selectedRevision,
    inspectorTab,
    diffPreferences: preferences.diff,
    binaryDiffVisible: preferences.binaryDiffVisible,
    revisionChangesDiffVisible: preferences.revisionChangesDiffVisible,
    demoRevisionFiles
  })

  const sharedStores = useSharedStoreController({
    applicationMode,
    settingsOpen,
    beginOperation,
    finishOperation,
    notify
  })
  const {
    busyAction,
    setBusyAction,
    activateSnapshot,
    openRepository,
    openServer: refreshServerRepositories,
    initializationDialog,
    serverDialog,
    cloneDialog
  } = useRepositoryEntryController({
    applicationMode,
    defaultIdentity: preferences.defaultIdentity,
    sharedStoreInfo: sharedStores.info,
    activateRepositorySnapshot,
    upsertSnapshot,
    setActiveView,
    setServerDialogOpen,
    tryBeginRepositoryMutation,
    finishRepositoryMutation,
    beginOperation,
    finishOperation,
    refreshSharedStores: sharedStores.refresh,
    notify,
    serverDialogOpen,
    authStateVersion: remoteAuthentication.authStateVersion,
    onAuthenticationRequired: remoteAuthentication.requestAuthentication,
    onAuthStateChange: remoteAuthentication.refreshAuthenticationState
  })
  useRepositorySessionLifecycle({
    applicationMode,
    snapshots,
    activeRepositoryId,
    unavailableRepositoryPaths,
    replaceRepositorySession,
    activateSnapshot,
    updatePreferences,
    setBusyAction,
    notify
  })
  /**
   * 写操作成功后统一重读仓库快照，确保 UI 以 Lore 的最终事件为准，
   * 不用本地乐观状态掩盖冲突、远端推进或文件扫描差异。
   *
   * `labelKey` 必须是语义键而非已翻译文案；busy 状态与 Toast 都在使用时再 `t()`，
   * 避免启动恢复等长操作期间切换语言后仍显示旧语言。
   */
  const runRepositoryMutation = useCallback(
    async (
      labelKey: string,
      task: (repository: Repository) => Promise<unknown>,
      successDetail: string | OperationDetail,
      nextView?: NavigationView,
      projectSnapshot?: (activeSnapshot: RepositorySnapshot, mutationResult: unknown) => RepositorySnapshot
    ) => {
      if (!activeSnapshot) {
        await openRepository()
        return false
      }
      if (!tryBeginRepositoryMutation()) {
        notify(t('repositoryOperationInProgress'), t('waitCurrentLoreCommandFinish_8cd5'), 'warning')
        return false
      }

      try {
        setBusyAction(labelKey)
        return await runRepositoryMutationLifecycle({
          activeSnapshot,
          labelKey,
          task,
          projectSnapshot,
          successDetail,
          nextView,
          loadSnapshot: (repositoryPath) => loadRepositorySnapshot(repositoryPath, false),
          applySnapshot: (snapshot) => {
            upsertSnapshot(snapshot)
            activateSnapshot(snapshot)
          },
          selectView: setActiveView,
          focusConflictFile: (file) => {
            const objectId = changeFileObjectId(file.id)
            selectChangeFiles([objectId], objectId)
          },
          conflictTitle: (snapshot) =>
            snapshot.conflictSession ? conflictOperationLabel(snapshot.conflictSession.kind) : t('conflictDetected'),
          notify,
          beginOperation,
          finishOperation
        })
      } finally {
        finishRepositoryMutation()
        setBusyAction(null)
      }
    },
    [
      activateSnapshot,
      activeSnapshot,
      beginOperation,
      finishOperation,
      finishRepositoryMutation,
      notify,
      openRepository,
      selectChangeFiles,
      setActiveView,
      setBusyAction,
      tryBeginRepositoryMutation,
      upsertSnapshot
    ]
  )

  const {
    branchCreateSource,
    tagCreateSource,
    editingTag,
    tagDetails,
    tagMenu,
    versionMenu,
    openBranchCreateDialog,
    closeBranchCreateDialog,
    openTagCreateDialog,
    closeTagDialog,
    showTagDetails,
    closeTagMenu,
    closeVersionMenu,
    createNewBranch,
    openCurrentBranchCreateDialog,
    openCurrentTagCreateDialog,
    createNewTag,
    saveTagChanges,
    selectTag,
    locateTagRevision,
    locateArchivedBranchRevision,
    openTagContextMenu,
    beginEditingTag,
    deleteTagFromMenu,
    selectBranch,
    locateSidebarBranchRevision,
    openRevisionContextMenu,
    openBranchContextMenu,
    openRevisionInInspector,
    checkoutRevisionFromList,
    cherryPickFromMenu,
    revertFromMenu,
    switchBranchFromMenu,
    pushBranchFromMenu,
    mergeBranchFromMenu,
    archiveBranchFromMenu
  } = useAppVersionActions({
    applicationMode,
    activeSnapshot,
    activeRepository,
    notify,
    runRepositoryMutation,
    setActiveView,
    setSelectedRevisionId,
    setSelectedBranchId,
    setSelectedTagId,
    revealRevision
  })

  const {
    fileHistoryRequest,
    fileHistoryEntries,
    fileHistoryLoading,
    fileHistoryError,
    stageChangeFiles,
    stageAll,
    resolveConflictFiles,
    abortConflict,
    openChangeFile,
    openWorkspaceChangeExternally,
    openRevisionChangeExternally,
    openConflictExternally,
    saveChangesPatch,
    discardChangeFiles,
    ignoreChangeFiles,
    openFileHistory,
    closeFileHistory,
    createRevision
  } = useLocalChangeActions({
    applicationMode,
    activeSnapshot,
    activeRepository,
    selectedRevision,
    revisionDiffSource,
    diffPreferences: preferences.diff,
    defaultIdentity: preferences.defaultIdentity,
    notify,
    runRepositoryMutation,
    upsertSnapshot
  })

  /** 从配置页直接 Push 当前分支；远端地址必须已经落盘，不能使用未保存草稿。 */
  const pushCurrentRepository = useCallback(async () => {
    if (!activeSnapshot?.repository.remoteUrl) {
      notify(t('unableToPush'), t('saveTheLoreServerAddressFirst'), 'warning')
      return
    }
    if (
      !confirmLocalized(
        t('confirm.pushCurrentBranch', {
          branch: activeSnapshot.repository.branch,
          remote: activeSnapshot.repository.remoteUrl
        })
      )
    ) {
      return
    }
    await runRepositoryMutation(
      'pushBranch',
      (repository) => pushBranch(repository.path, repository.branch),
      operationMessage('status.pushedToRemote', {
        name: activeSnapshot.repository.branch
      })
    )
  }, [activeSnapshot, notify, runRepositoryMutation])

  /** Repository Tools 关闭后再切换主视图，避免弹层保留旧 Revision 上下文。 */
  const locateRevisionFromTools = useCallback(
    (revision: string) => {
      setSelectedRevisionId(revision)
      setActiveView('history')
    },
    [setActiveView, setSelectedRevisionId]
  )
  const repositoryTools = useRepositoryToolsController({
    applicationMode,
    activeSnapshot,
    repositorySnapshots: snapshots,
    authAccountBindings: preferences.authAccountBindings,
    onAuthAccountBindingsChange: (authAccountBindings) => updatePreferences({ authAccountBindings }),
    defaultIdentity: preferences.defaultIdentity,
    busyAction,
    initialDependencyQuery: dependencyGraphFixtureEnabled ? browserDependencyGraphFixture : null,
    notify,
    openRepository,
    runRepositoryMutation,
    upsertSnapshot,
    pushCurrentRepository,
    locateRevision: locateRevisionFromTools,
    authStateVersion: remoteAuthentication.authStateVersion,
    onAuthenticationRequired: remoteAuthentication.requestAuthentication,
    onAuthStateChange: remoteAuthentication.refreshAuthenticationState
  })
  const {
    fileLocks,
    fileLockState,
    open: openRepositoryTools,
    acquireFileLocks: acquireActiveFileLocks,
    releaseFileLocks: releaseActiveFileLocks
  } = repositoryTools
  const selectedFileLock = selectedChange
    ? (fileLocks.find((lock) => lock.path === changeFilePath(selectedChange)) ?? null)
    : null
  const { revealCurrentFile, resetRevisionFile } = useRevisionFileActions({
    applicationMode,
    activeSnapshot,
    runRepositoryMutation,
    notify
  })
  const { handleToolbarAction } = useAppToolbarActions({
    applicationMode,
    activeSnapshot,
    openRepository,
    openServer: refreshServerRepositories,
    openRepositoryTool: openRepositoryTools,
    runRepositoryMutation,
    resetLayout,
    setActiveView,
    setCommandPaletteOpen,
    setSettingsOpen,
    setSettingsInitialCategory,
    setSearchOpen,
    setOperationsOpen,
    setAboutOpen,
    notify
  })

  const appOverlays = (
    <>
      <AppGlobalOverlays
        commandPalette={
          commandPaletteOpen
            ? {
                onClose: () => setCommandPaletteOpen(false),
                onRun: (action) => void handleToolbarAction(action)
              }
            : null
        }
        initialization={initializationDialog}
        server={serverDialogOpen ? serverDialog : null}
        clone={cloneDialog}
        settings={
          settingsOpen
            ? {
                preference,
                language: preferences.language,
                automaticallyCheckForUpdates: preferences.automaticallyCheckForUpdates,
                binaryPreviewLimitMib: preferences.binaryPreviewLimitMib,
                defaultIdentity: preferences.defaultIdentity,
                externalDiffTools: preferences.externalDiffTools,
                externalMergeTools: preferences.externalMergeTools,
                availableExternalToolIds,
                initialCategory: settingsInitialCategory,
                sharedStoreInfo: sharedStores.info,
                sharedStoreLoading: sharedStores.loading,
                sharedStoreBusy: sharedStores.busy,
                sharedStoreError: sharedStores.error,
                initialSharedStoreRemoteUrl: activeSnapshot?.repository.serverUrl ?? DEFAULT_SERVER_URL,
                onPreferenceChange: setPreference,
                onLanguageChange: (language) => updatePreferences({ language }),
                onAutomaticallyCheckForUpdatesChange: (automaticallyCheckForUpdates) =>
                  updatePreferences({ automaticallyCheckForUpdates }),
                onBinaryPreviewLimitMibChange: (binaryPreviewLimitMib) => updatePreferences({ binaryPreviewLimitMib }),
                onDefaultIdentityChange: (defaultIdentity) => updatePreferences({ defaultIdentity }),
                onExternalDiffToolsChange: (externalDiffTools) => updatePreferences({ externalDiffTools }),
                onExternalMergeToolsChange: (externalMergeTools) => updatePreferences({ externalMergeTools }),
                onChooseExternalDiffExecutable: selectExternalDiffExecutable,
                onRefreshSharedStores: () => void sharedStores.refresh(),
                onChooseSharedStoreParent: sharedStores.chooseParent,
                onCreateSharedStore: (remoteUrl, parentPath) => void sharedStores.create(remoteUrl, parentPath),
                onSharedStoreAutomaticChange: (enabled) => void sharedStores.setAutomatic(enabled),
                updateState,
                onCheckForUpdates: () => void appUpdater.checkForUpdates(),
                onShowUpdate: showUpdate,
                onResetLayout: () => {
                  resetLayout()
                  notify(t('workspaceLayoutRestored'), t('paneWidthsHaveBeenReset'), 'success')
                },
                onClose: () => setSettingsOpen(false)
              }
            : null
        }
        search={
          searchOpen && activeSnapshot
            ? {
                revisions: activeSnapshot.revisions,
                branches: activeSnapshot.branches,
                changes: activeSnapshot.changes,
                onSelect: handleSearchResult,
                onClose: () => setSearchOpen(false)
              }
            : null
        }
        operations={
          operationsOpen
            ? {
                operations,
                streams: loreOperationStreams,
                onClear: clearCompletedOperations,
                onClose: () => setOperationsOpen(false)
              }
            : null
        }
        about={aboutOpen ? { runtimeInfo, onClose: () => setAboutOpen(false) } : null}
        update={
          updateDialogOpen && updateState.availableVersion
            ? {
                state: updateState,
                // 浏览器夹具只验证界面；主操作关闭预览，不伪造下载或安装成功。
                onInstall: updateDialogFixtureEnabled
                  ? () => setUpdateDialogOpen(false)
                  : () => void appUpdater.installUpdate(),
                onClose: () => setUpdateDialogOpen(false)
              }
            : null
        }
        remoteAuthentication={
          remoteAuthentication.authenticationTarget
            ? {
                target: remoteAuthentication.authenticationTarget,
                busy: remoteAuthentication.authenticationBusy,
                error: remoteAuthentication.authenticationError,
                onAuthenticate: () => void remoteAuthentication.authenticate(),
                onContinueOffline: remoteAuthentication.continueOffline
              }
            : null
        }
      />
      <AppRepositoryOverlays
        branchCreate={
          branchCreateSource
            ? {
                busy: busyAction === 'createBranch',
                source: branchCreateSource,
                onCreate: (name) => void createNewBranch(name),
                onClose: closeBranchCreateDialog
              }
            : null
        }
        tagEditor={
          tagCreateSource || editingTag
            ? {
                busy: busyAction === 'createTag' || busyAction === 'editTag',
                source: editingTag
                  ? {
                      kind: 'revision',
                      branch: editingTag.branch,
                      revision: editingTag.revision
                    }
                  : tagCreateSource!,
                tag: editingTag,
                onSubmit: (name, message) =>
                  editingTag ? void saveTagChanges(name, message) : void createNewTag(name, message),
                onClose: () => {
                  if (busyAction === 'createTag' || busyAction === 'editTag') return
                  closeTagDialog()
                }
              }
            : null
        }
        tagDetails={
          tagDetails
            ? {
                tag: tagDetails,
                onEdit: beginEditingTag,
                onLocateRevision: locateTagRevision,
                onClose: () => showTagDetails(null)
              }
            : null
        }
        fileHistory={
          fileHistoryRequest && activeSnapshot
            ? {
                file: fileHistoryRequest.file,
                mode: fileHistoryRequest.mode,
                entries: fileHistoryEntries,
                revisions: activeSnapshot.revisions,
                loading: fileHistoryLoading,
                error: fileHistoryError,
                onSelectRevision: (revision) => {
                  setSelectedRevisionId(revision.id)
                  setActiveView('history')
                  closeFileHistory()
                },
                onClose: closeFileHistory
              }
            : null
        }
        repositoryTools={{ controller: repositoryTools }}
        versionMenu={
          versionMenu
            ? {
                request: versionMenu,
                currentBranch: activeRepository.branch,
                currentRevisionId: activeSnapshot?.repository.revision,
                busy: busyAction !== null,
                onClose: closeVersionMenu,
                onOpenRevision: openRevisionInInspector,
                onCheckoutRevision: (revision) => void checkoutRevisionFromList(revision),
                onCherryPickRevision: (revision) => void cherryPickFromMenu(revision),
                onRevertRevision: (revision) => void revertFromMenu(revision),
                onSwitchBranch: (branch) => void switchBranchFromMenu(branch),
                onPushBranch: (branch) => void pushBranchFromMenu(branch),
                onMergeBranch: (branch) => void mergeBranchFromMenu(branch),
                onArchiveBranch: (branch) => void archiveBranchFromMenu(branch),
                onOpenBranchRevision: locateArchivedBranchRevision,
                onCreateBranch: openBranchCreateDialog,
                onCreateTag: openTagCreateDialog,
                onNotify: notify
              }
            : null
        }
        tagMenu={
          tagMenu
            ? {
                request: tagMenu,
                busy: busyAction !== null,
                onClose: closeTagMenu,
                onDetails: showTagDetails,
                onLocateRevision: locateTagRevision,
                onEdit: beginEditingTag,
                onDelete: (tag) => void deleteTagFromMenu(tag),
                onNotify: notify
              }
            : null
        }
      />
    </>
  )

  return (
    <AppShell
      repository={activeRepository}
      theme={resolvedTheme}
      operationCount={activeOperationCount}
      repositoryTabs={snapshots.map((snapshot) => ({
        sessionKey: repositorySessionKey(snapshot),
        repository: snapshot.repository
      }))}
      activeRepositoryId={activeRepositoryId}
      runtimeInfo={runtimeInfo}
      busyLabel={busyAction ? t(busyAction as never) : null}
      demoMode={applicationMode === 'browser-demo'}
      toast={toast}
      onToolbarAction={(action) => void handleToolbarAction(action)}
      onToggleTheme={toggleTheme}
      onOpenCommands={() => setCommandPaletteOpen(true)}
      onSelectRepository={(repositoryId) => {
        const snapshot = snapshots.find((item) => repositorySessionKey(item) === repositoryId)
        if (snapshot) activateSnapshot(snapshot)
      }}
      onCloseRepository={(repositoryId) => {
        const next = removeRepositorySnapshot(repositoryId)
        if (next) activateSnapshot(next)
      }}
      onReorderRepositories={reorderRepositoryTabs}
      onAddRepository={() => void openRepository()}
      onCloseToast={closeToast}
      overlays={appOverlays}
    >
      <AppWorkspace
        workspaceRef={workspaceRef}
        repositoryOpen={Boolean(activeSnapshot)}
        sidebarWidth={layout.sidebarWidth}
        inspectorWidth={layout.inspectorWidth}
        inspectorVisible={workspaceInspectorVisible}
      >
        {!activeSnapshot ? (
          <RepositoryWelcome
            busyLabel={busyAction ? t(busyAction as never) : null}
            onOpen={() => void openRepository()}
            onOpenServer={() => void refreshServerRepositories()}
          />
        ) : (
          <>
            <Sidebar
              repository={activeRepository}
              branches={activeSnapshot.branches}
              tags={activeSnapshot.tags}
              demoMode={applicationMode === 'browser-demo'}
              activeView={activeView}
              selectedBranchId={selectedBranchId}
              selectedTagId={selectedTagId}
              changeCount={activeSnapshot.changes.length}
              onViewChange={setActiveView}
              onBranchSelect={locateSidebarBranchRevision}
              onBranchCheckout={(branch) => void switchBranchFromMenu(branch)}
              onBranchContextMenu={openBranchContextMenu}
              onTagSelect={selectTag}
              onTagLocateRevision={locateTagRevision}
              onTagContextMenu={openTagContextMenu}
              onOpenOperations={() => setOperationsOpen(true)}
              onOpenServer={() => void refreshServerRepositories()}
              onOpenConfiguration={() => void openRepositoryTools('configuration')}
              onOpenAccounts={() => void openRepositoryTools('accounts')}
              onOpenRepositoryTools={() => void openRepositoryTools('maintenance')}
            />

            <PaneResizer
              label={t('resizeTheSidebar')}
              value={layout.sidebarWidth}
              direction="right"
              container={workspaceRef.current}
              onChange={resizeSidebar}
              onReset={resetLayout}
            />

            {activeView === 'history' && (
              <HistoryPanelContainer
                applicationMode={applicationMode}
                snapshot={activeSnapshot}
                selectedId={selectedRevisionId}
                revealRequest={revisionRevealRequest}
                onSelectedIdChange={setSelectedRevisionId}
                onSnapshotChange={upsertSnapshot}
                onCheckout={(revision) => void checkoutRevisionFromList(revision)}
                onContextMenu={openRevisionContextMenu}
                onTagSelect={selectTag}
                onTagContextMenu={openTagContextMenu}
                notify={notify}
              />
            )}

            {activeView === 'changes' && (
              <LocalChanges
                repositoryPath={activeRepository.path}
                repositoryIdentity={activeRepository.identity}
                branches={activeSnapshot.branches}
                currentBranch={activeRepository.branch}
                files={activeSnapshot.changes}
                fileLocks={fileLocks}
                fileLockState={fileLockState}
                lockAvailable={applicationMode === 'tauri'}
                conflictSession={activeSnapshot.conflictSession}
                selectedIds={selectedChangeIds}
                busy={Boolean(busyAction)}
                refreshing={refreshingRepositoryPaths.has(activeRepositoryPath)}
                refreshAvailable={applicationMode === 'tauri' && Boolean(activeRepositoryPath)}
                onRefresh={() => void refreshActiveRepositorySnapshot()}
                onSelectionChange={selectChangeFiles}
                onStageFiles={(files, staged) => void stageChangeFiles(files, staged)}
                onStageAll={(staged) => void stageAll(staged)}
                onCreateRevision={(message) => void createRevision(message)}
                onOpenFile={(file) => void openChangeFile(file)}
                externalDiffTools={availableExternalDiffTools}
                externalMergeTools={activeSnapshot.conflictSession?.incomingRevision ? availableExternalMergeTools : []}
                onExternalDiff={(file, tool) => void openWorkspaceChangeExternally(file, tool)}
                onExternalMerge={(file, tool) => void openConflictExternally(file, tool)}
                onRevealFile={(file) => void revealCurrentFile(file)}
                onFileHistory={(file, mode) => void openFileHistory(file, mode)}
                onDiscardFiles={(files) => void discardChangeFiles(files)}
                onIgnoreFiles={(files, byExtension) => void ignoreChangeFiles(files, byExtension)}
                onSavePatch={(files) => void saveChangesPatch(files)}
                onAcquireFileLocks={(files) => void acquireActiveFileLocks(files.map(changeFilePath))}
                onReleaseFileLocks={(files) => void releaseActiveFileLocks(files.map(changeFilePath))}
                onOpenLockManager={() => void openRepositoryTools('locks')}
                onConflictAction={(action, files) => void resolveConflictFiles(action, files)}
                onAbortConflict={() => void abortConflict()}
                onNotify={notify}
              />
            )}

            {activeView === 'branches' && (
              <BranchOverview
                branches={activeSnapshot.branches}
                demoMode={applicationMode === 'browser-demo'}
                selectedBranchId={selectedBranchId}
                onSelect={selectBranch}
                onCheckout={(branch) => void switchBranchFromMenu(branch)}
                onContextMenu={openBranchContextMenu}
                onCreate={openCurrentBranchCreateDialog}
              />
            )}

            {activeView === 'tags' && (
              <TagOverview
                tags={activeSnapshot.tags}
                selectedTagId={selectedTagId}
                onSelect={selectTag}
                onLocateRevision={locateTagRevision}
                onContextMenu={openTagContextMenu}
                onCreate={openCurrentTagCreateDialog}
              />
            )}

            {workspaceInspectorVisible && (
              <>
                <PaneResizer
                  label={t('resizeTheInspector')}
                  value={layout.inspectorWidth}
                  direction="left"
                  container={workspaceRef.current}
                  onChange={resizeInspector}
                  onReset={resetLayout}
                />

                {activeView === 'changes' ? (
                  <WorkingTreeDiffContainer
                    applicationMode={applicationMode}
                    repositoryPath={activeRepository.path}
                    currentRevisionId={currentRevisionId}
                    file={selectedChange}
                    fileLock={selectedFileLock ?? undefined}
                    selectionLabel={selectedChangeFolder}
                    selectedCount={selectedChangeIds.length}
                  />
                ) : (
                  <Inspector
                    revision={inspectorRevision}
                    files={visibleInspectorFiles}
                    treeFiles={visibleRevisionFiles}
                    treeReady={revisionTreeReady}
                    treeLoading={revisionFilesLoading}
                    treeError={revisionFilesError}
                    diffs={revisionDiffs}
                    changeListLoading={revisionChangesLoading}
                    changeListError={revisionChangesError}
                    changeListReady={
                      applicationMode === 'browser-demo' || revisionChangesRevisionId === inspectorRevision?.id
                    }
                    revisionDiffSource={revisionDiffSource}
                    onRevisionDiffSourceChange={selectRevisionDiffSource}
                    diffLoading={revisionDiffLoading}
                    diffError={revisionDiffError}
                    diffNotice={revisionDiffNotice}
                    demoMode={applicationMode === 'browser-demo'}
                    repositoryPath={activeRepository.path}
                    activeTab={inspectorTab}
                    onTabChange={setInspectorTab}
                    onLoadBinaryPreview={applicationMode === 'tauri' ? loadActiveRepositoryBinaryPreview : undefined}
                    onPrimaryChangeFile={selectRevisionPrimaryChange}
                    onNotify={notify}
                    onRevealFile={(file) => void revealCurrentFile(file)}
                    onFileHistory={(file) => void openFileHistory(file, 'history', inspectorRevision?.id)}
                    onResetFile={(files, targetRevision, targetLabel) =>
                      void resetRevisionFile(files, targetRevision, targetLabel)
                    }
                    externalDiffTools={availableExternalDiffTools}
                    onExternalDiff={(file, tool) => void openRevisionChangeExternally(file, tool)}
                    onOpenOperations={() => setOperationsOpen(true)}
                  />
                )}
              </>
            )}
          </>
        )}
      </AppWorkspace>
    </AppShell>
  )
}

export default App
