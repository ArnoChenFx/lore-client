import { t } from '../../i18n'

/**
 * Lore 适配层使用稳定英文标识串联日志、诊断与流式状态。这里仅负责展示映射，
 * 不能改写 DTO 中的原值，否则会破坏事件归并，也会让运行期语言切换无法重译。
 *
 * 多个底层步骤可以共享一个用户语义。例如从指定分支创建分支时包含临时检出、
 * 创建和恢复三个阶段；会话记录应说明阶段目的，而不是暴露内部命令拼装方式。
 */
const LORE_OPERATION_LABEL_KEYS = {
  'auth.list': 'listAccounts',
  'auth.local-user-info': 'resolveAccountNames',
  'auth.user-info': 'resolveRevisionAuthors',
  'auth.login-interactive': 'signInWithBrowser',
  'auth.login-with-token': 'signInWithToken',
  'auth.logout': 'signOut',
  'auth.clear': 'clearCredentials',
  'repository.list': 'listRepositories',
  'repository.info': 'readRemoteRepositoryInformation',
  'repository.clone': 'cloneRepository',
  'repository.config-get': 'readRepositoryConfiguration',
  'repository.status': 'readRepositoryStatus',
  'repository.verify': 'verifyRepository',
  'repository.verify-heal': 'healRepository',
  'repository.verify-fragment': 'verifyRepositoryFragment',
  'repository.dump': 'dumpRepositoryState',
  'repository.instance-list': 'listRepositoryInstances',
  'repository.instance-prune': 'pruneRepositoryInstances',
  'repository.instance-update-path': 'updateRepositoryInstancePath',
  'repository.metadata-get': 'readRepositoryMetadata',
  'repository.gc': 'collectRepositoryStorage',
  'repository.create.local': 'createLocalRepository',
  'repository.create.remote': 'createRemoteRepository',
  'repository.release.config': 'updateRepositoryConfiguration',
  'repository.view-status': 'inspectSelectiveSyncView',
  'repository.view-apply': 'applySelectiveSyncView',
  'repository.view-rollback': 'restoreSelectiveSyncView',
  'repository.status.revision': 'readRevisionStatus',
  'shared_store.info': 'readSharedStore',
  'shared_store.create': 'createSharedStore',
  'shared_store.set_use_automatically': 'updateSharedStorePolicy',
  'lock.file-query': 'queryFileLocks',
  'lock.file-status': 'readFileLockStatus',
  'lock.file-acquire': 'acquireFileLock',
  'lock.file-release': 'releaseFileLock',
  'file.dependency-add': 'addFileDependency',
  'file.dependency-remove': 'removeFileDependency',
  'file.dependency-list': 'listFileDependencies',
  'file.stage': 'stageFiles',
  'file.unstage': 'unstageFiles',
  'file.reset': 'resetFiles',
  'file.diff': 'readWorkspaceDiff',
  'file.diff.revision': 'readRevisionDiff',
  'file.history': 'readFileHistory',
  'file.metadata-list': 'readFileMetadata',
  'file.discard-workspace': 'discardWorkspaceChanges',
  'revision.history': 'readRevisionHistory',
  'revision.metadata-list': 'readRevisionMetadata',
  'revision.info': 'readRevisionInformation',
  'revision.find': 'findRevision',
  'revision.amend': 'amendRevision',
  'revision.bisect': 'bisectRevision',
  'revision.restore': 'restoreRevision',
  'revision.commit': 'commitRevision',
  'revision.sync': 'syncRevision',
  'revision.checkout': 'checkoutRevision',
  'revision.cherry-pick': 'cherryPickRevision',
  'revision.revert': 'revertRevision',
  'revision.cherry-pick-resolve': 'resolveCherryPickConflict',
  'revision.cherry-pick-resolve-mine': 'resolveCherryPickWithMine',
  'revision.cherry-pick-resolve-theirs': 'resolveCherryPickWithTheirs',
  'revision.cherry-pick-unresolve': 'markCherryPickUnresolved',
  'revision.cherry-pick-restart': 'restartCherryPick',
  'revision.cherry-pick-abort': 'abortCherryPick',
  'revision.revert-resolve': 'resolveRevertConflict',
  'revision.revert-resolve-mine': 'resolveRevertWithMine',
  'revision.revert-resolve-theirs': 'resolveRevertWithTheirs',
  'revision.revert-unresolve': 'markRevertUnresolved',
  'revision.revert-restart': 'restartRevert',
  'revision.revert-abort': 'abortRevert',
  'branch.list': 'listBranches',
  'branch.metadata-get': 'readBranchMetadata',
  'branch.info': 'readBranchInformation',
  'branch.protection-info': 'readBranchProtection',
  'branch.diff': 'compareBranches',
  'branch.latest-list': 'listBranchRevisions',
  'branch.protect': 'protectBranch',
  'branch.unprotect': 'unprotectBranch',
  'branch.reset': 'resetBranch',
  'branch.protection-info.reset-check': 'verifyBranchResetProtection',
  'branch.info.reset-check': 'verifyBranchResetTarget',
  'branch.latest-list.reset-check': 'verifyBranchResetRevision',
  'branch.create-from.checkout': 'prepareBranchSource',
  'branch.create-from.create': 'createBranch',
  'branch.create-from.restore': 'restoreOriginalBranch',
  'branch.push': 'pushBranch',
  'branch.push.publish': 'publishBranch',
  'branch.switch': 'switchBranch',
  'branch.merge-start': 'mergeBranch',
  'branch.merge-resolve': 'resolveMergeConflict',
  'branch.merge-resolve-mine': 'resolveMergeWithMine',
  'branch.merge-resolve-theirs': 'resolveMergeWithTheirs',
  'branch.merge-unresolve': 'markMergeUnresolved',
  'branch.merge-restart': 'restartMerge',
  'branch.merge-abort': 'abortMerge',
  'branch.archive': 'archiveBranch',
  'conflict.session.status': 'readConflictStatus',
  'conflict.session.revision-info': 'readConflictRevision',
  'layer.list': 'listLayers',
  'layer.list-staged': 'listStagedLayers',
  'layer.add': 'addLayer',
  'layer.remove': 'removeLayer',
  'link.list': 'listLinks',
  'link.list-staged': 'listStagedLinks',
  'link.info': 'listLinks',
  'link.add': 'addLink',
  'link.remove': 'removeLink',
  'link.update': 'updateLink',
  'tag.list': 'listTags',
  'tag.write': 'writeTag',
  'tag.clear': 'clearTag',
  'storage.open': 'openStorage',
  'storage.close': 'closeStorage',
  'storage.get': 'readStorageContent',
  'revision_tree.load': 'loadRevisionTree',
  'revision_tree.list_children': 'listChildRevisions',
  'revision_tree.close': 'closeRevisionTree'
} as const

/**
 * `lastEventTag` 表示流中最近收到的数据类型，不等同于操作生命周期 phase。
 * 映射常见 Lore 事件后，用户既能看到“已完成”，也能理解最后处理到哪类数据。
 */
const LORE_EVENT_LABEL_KEYS = {
  start: 'started',
  begin: 'started',
  end: 'finished',
  complete: 'finished',
  error: 'failed',
  adapterOperationPhase: 'operationPhaseChanged',
  adapterSerializationError: 'serializationFailed',
  authIdentity: 'accountIdentity',
  branchDiffChange: 'branchChange',
  branchDiffConflict: 'branchConflict',
  branchInfo: 'branchInformation',
  branchLatestListEntry: 'branchRevision',
  branchListEntry: 'branch',
  cloneProgress: 'cloneProgress',
  fileDependencyListEntry: 'fileDependency',
  fileDependencyListFile: 'dependencySourceFile',
  fileDependencyListFileEnd: 'dependencySourceFinished',
  fileDiff: 'fileDifference',
  fileHistory: 'fileHistory',
  layerEntry: 'layer',
  layerStagedEntry: 'stagedLayer',
  linkEntry: 'link',
  linkStagedEntry: 'stagedLink',
  lockFileQuery: 'fileLockQuery',
  lockFileStatus: 'fileLockStatus',
  metadata: 'metadata',
  repositoryConfigGet: 'repositoryConfiguration',
  repositoryCreate: 'repositoryCreated',
  repositoryListEntry: 'repository',
  repositoryData: 'repositoryInformation',
  repositoryInstance: 'repositoryInstance',
  repositoryVerifyStateBegin: 'repositoryVerification',
  repositoryVerifyStateEnd: 'repositoryVerificationFinished',
  repositoryVerifyFragment: 'fragmentVerification',
  repositoryVerifyFragmentRemote: 'remoteFragmentVerification',
  repositoryStateDump: 'repositoryStateDump',
  repositoryStateDumpNode: 'repositoryStateNode',
  repositoryStatusFile: 'fileStatus',
  repositoryStatusRevision: 'revisionStatus',
  revisionBisect: 'bisectResult',
  revisionCommitRevision: 'committedRevision',
  revisionFind: 'foundRevision',
  revisionHistory: 'revisionHistory',
  revisionHistoryEntry: 'revision',
  revisionInfo: 'revisionInformation',
  revisionInfoDelta: 'revisionDelta',
  revisionTreeChild: 'childRevision',
  revisionTreeListChildrenBegin: 'listingChildRevisions',
  revisionTreeLoaded: 'revisionTreeLoaded',
  sharedStoreInfo: 'sharedStoreInformation',
  storageGetData: 'storageContent',
  storageGetItemComplete: 'storageItemFinished',
  storageOpened: 'storageOpened'
} as const

/** 将操作协议标识解析为当前语言下的用户可见名称。 */
export function resolveLoreOperationLabel(operation: string): string {
  const labelKey = LORE_OPERATION_LABEL_KEYS[operation as keyof typeof LORE_OPERATION_LABEL_KEYS]
  return labelKey ? t(`loreOperation.${labelKey}` as never) : humanizeLoreIdentifier(operation)
}

/** 将最近事件标签解析为当前语言下的用户可见阶段。 */
export function resolveLoreEventLabel(tagName: string | undefined): string {
  if (!tagName) return '—'
  const labelKey = LORE_EVENT_LABEL_KEYS[tagName as keyof typeof LORE_EVENT_LABEL_KEYS]
  return labelKey ? t(`loreEvent.${labelKey}` as never) : humanizeLoreIdentifier(tagName)
}

/**
 * Lore 0.x 未来可能新增事件。未知值不能被隐藏或误译，但也不应继续以
 * `snake_case`、`dot.case` 或 camelCase 协议文本原样污染界面。
 */
export function humanizeLoreIdentifier(identifier: string): string {
  const readable = identifier
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!readable) return identifier
  return readable.replace(/\b[a-z]/g, (character) => character.toUpperCase())
}
