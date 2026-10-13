/**
 * Lore 服务门面：实现已按领域拆分到同目录模块，这里只重新导出原有的公开名称，
 * 保证所有消费方的导入路径和导出契约保持不变。
 */
export {
  clearAuthIdentities,
  listAuthIdentities,
  loginAuthInteractive,
  loginAuthWithToken,
  logoutAuthIdentity,
  refreshRepositoryAuthenticationContexts,
  setRepositoryAuthAccountBinding,
  subscribeRemoteAuthenticationRequired
} from './auth'
export type { RemoteAuthenticationRequiredEvent } from './auth'
export {
  archiveBranch,
  cherryPickRevision,
  createBranchFromSource,
  loadBranchCollaboration,
  loadBranchDiff,
  mergeBranch,
  resetBranchLatest,
  revertRevision,
  setBranchProtected,
  switchBranch
} from './branches'
export {
  addLayer,
  addLink,
  listLayers,
  listLinks,
  loadLinkInfo,
  removeLayer,
  removeLink,
  updateLink
} from './composition'
export {
  applyRepositoryView,
  loadRepositoryConfig,
  loadRepositoryView,
  previewRepositoryView,
  updateRepositoryConfig
} from './config'
export { loadConflictSession, runConflictAction, writeConflictResolution } from './conflicts'
export type { ConflictResolutionWriteResult } from './conflicts'
export {
  DEFAULT_SERVER_URL,
  LoreCommandClientError,
  LoreOperationError,
  connectRepositoryNotifications,
  getApplicationMode,
  getLoreRuntimeInfo,
  isAuthenticationRequiredError,
  resolveDefaultServerUrl,
  subscribeLoreOperationStream
} from './core'
export {
  addFileDependency,
  collectFileDependencyGraph,
  listFileDependencies,
  loadFileDependencyGraph,
  parseFileDependencies,
  removeFileDependency
} from './dependencies'
export {
  collectRepositoryGarbage,
  dumpRepositoryState,
  listRepositoryInstances,
  parseDiagnosticReport,
  pruneRepositoryInstances,
  updateRepositoryInstancePath,
  verifyRepository,
  verifyRepositoryFragment,
  verifyRepositoryPath
} from './diagnostics'
export { loreEventParsers } from './eventParsers'
export {
  detectExternalTools,
  openExternalDiff,
  openExternalMerge,
  savePatchFile,
  selectExternalDiffExecutable,
  withPatchExtension
} from './externalTools'
export { acquireFileLocks, loadFileLockStatus, parseFileLocks, queryFileLocks, releaseFileLocks } from './locks'
export { loadMetadata, parseMetadataEntries } from './metadata'
export {
  binaryPreviewCompletionTimeoutMs,
  createBinaryPreviewStreamAssembler,
  decodeBinaryFilePreviewEnvelope,
  loadBinaryFilePreview,
  loadRevisionText,
  loadWorkspaceText
} from './previews'
export {
  cloneRepository,
  hydrateRemoteRepositoryDetails,
  listRemoteRepositories,
  loadRemoteRepositoryInfo
} from './remote'
export {
  LoreRepositoryPublishError,
  createSharedStore,
  initializeRepository,
  loadRepositorySnapshot,
  loadSharedStoreInfo,
  loadSharedStoreRegistry,
  probeRepositoryDirectory,
  publishRepository,
  repositoryPublishFailureMessage,
  selectCloneParentDirectory,
  selectCloneViewFile,
  selectRepositoryDirectory,
  selectSharedStoreParentDirectory,
  setSharedStoreUseAutomatically
} from './repositories'
export {
  amendCurrentRevision,
  bisectRevisionRange,
  checkoutRevision,
  findRevisionByMetadata,
  findRevisionByNumber,
  loadFileHistory,
  loadRevisionChanges,
  loadRevisionDiff,
  loadRevisionFiles,
  loadRevisionHistory,
  loadRevisionInfo,
  restoreCurrentRevision,
  revisionDiffsToChangeFiles
} from './revisions'
export { createTag, deleteTag, listTags, updateTag } from './tags'
export {
  commitRevision,
  discardWorkspaceFiles,
  ignoreWorkspacePaths,
  loadWorkingTreeDiff,
  openWorkspace,
  openWorkspaceFile,
  pushBranch,
  resetFilesToRevision,
  revealWorkspaceFile,
  stageMove,
  stagePaths,
  syncRepository,
  unstagePaths
} from './workspace'
