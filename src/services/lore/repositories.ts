/** 仓库生命周期：探测、初始化、发布、共享存储与仓库快照加载。 */
import { isTauri } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'

import { t } from '../../i18n'
import type {
  LoreEvent,
  LoreOperationResult,
  LoreRepositoryInitializeOptions,
  LoreRepositoryInitializeResult,
  LoreRepositoryPublishResult,
  LoreSharedStoreInfo,
  LoreSharedStoreRegistry,
  Repository,
  RepositoryDirectoryProbe,
  RepositorySnapshot
} from '../../types'
import { parseBranches } from './branches'
import { RepositoryConfigValues, loadRepositoryConfig } from './config'
import { loadConflictSession } from './conflicts'
import { LoreOperationError, invokeCommand, runOperation } from './core'
import { parseChanges, parseRevisions } from './revisions'
import { listTags } from './tags'
import {
  colorFromText,
  eventData,
  isBooleanEvidence,
  normalizeDisplayPath,
  readBoolean,
  readNumber,
  readRevisionId,
  readString,
  stablePathId
} from './utils'

/** 发布失败仍保留远端创建、配置写入和 Push 三个阶段的真实完成状态。 */
export class LoreRepositoryPublishError extends Error {
  readonly result: LoreRepositoryPublishResult

  constructor(result: LoreRepositoryPublishResult) {
    super(repositoryPublishFailureMessage(result))
    this.name = 'LoreRepositoryPublishError'
    this.result = result
  }
}

/**
 * 打开原生目录选择器。目录权限仅授予当前应用会话，真实文件访问仍然由
 * Rust 端校验并交给 Lore Core 完成。
 */
export async function selectRepositoryDirectory(): Promise<string | null> {
  if (!isTauri()) {
    throw new Error(t('browserPreviewAccessLocalDirectories_2cd3'))
  }

  return open({
    directory: true,
    multiple: false,
    // 原生对话框标题不经过 JSX 边界，需显式翻译。
    title: t('chooseAProjectDirectory')
  })
}

/** 判断所选目录是普通目录、仓库根目录还是仓库内部子目录。 */
export async function probeRepositoryDirectory(directoryPath: string): Promise<RepositoryDirectoryProbe> {
  return invokeCommand<RepositoryDirectoryProbe>('lore_repository_probe', {
    directoryPath
  })
}

/**
 * 在普通目录原地初始化离线 Lore 仓库。
 *
 * `defaultIdentity` 只用于创建者元数据；仓库配置是否写入 identity 由用户单独填写
 * `repositoryIdentity` 决定，保持“仓库配置 > 客户端默认”的长期优先级。
 */
export async function initializeRepository(
  directoryPath: string,
  repositoryName: string,
  description: string,
  repositoryIdentity: string,
  defaultIdentity?: string,
  options: LoreRepositoryInitializeOptions = { useSharedStore: false }
): Promise<LoreRepositoryInitializeResult> {
  const initialized = await invokeCommand<LoreRepositoryInitializeResult>('lore_repository_initialize', {
    directoryPath,
    repositoryName,
    description,
    repositoryIdentity,
    defaultIdentity: defaultIdentity?.trim() || null,
    useSharedStore: options.useSharedStore,
    // 未启用时不能把残留草稿带过 IPC，避免后端误解为有效的 Store 选择。
    sharedStorePath: options.useSharedStore ? options.sharedStorePath?.trim() || null : null
  })
  if (initialized.result.status !== 0) {
    throw new LoreOperationError(initialized.result)
  }
  return {
    ...initialized,
    repositoryPath: normalizeDisplayPath(initialized.repositoryPath)
  }
}

/**
 * 创建同 ID 远端仓库、保存服务器根地址并 Push 当前分支。
 *
 * Rust 会把三个阶段的结果全部返回；后续阶段失败时抛出的错误仍携带完整 DTO，
 * UI 可以明确说明哪些远端状态已经无法自动回滚。
 */
export async function publishRepository(
  repositoryPath: string,
  repositoryName: string,
  description: string,
  identity: string,
  defaultIdentity: string,
  serverUrl: string,
  branch: string,
  userId?: string
): Promise<LoreRepositoryPublishResult> {
  const result = await invokeCommand<LoreRepositoryPublishResult>('lore_repository_publish', {
    repositoryPath,
    repositoryName,
    description,
    identity,
    defaultIdentity: defaultIdentity.trim() || null,
    serverUrl,
    branch,
    /*
     * Lore 0.x 通过全局 identity 在 Token Store 中定位 JWT。提交身份与认证账户
     * 属于两套客户端语义。useAuthAccount 需要与 userId 分开传递，才能区分“旧调用
     * 方未指定，允许 Rust 回退仓库绑定”和“用户在发布表单明确留空，强制匿名”。
     */
    userId: userId?.trim() || null,
    useAuthAccount: Boolean(userId?.trim())
  })
  if (result.failureStage || !result.pushed) {
    throw new LoreRepositoryPublishError(result)
  }
  return result
}

/** 把发布的部分成功状态转换为可直接展示、可安全重试的中文说明。 */
export function repositoryPublishFailureMessage(result: LoreRepositoryPublishResult): string {
  if (result.failureCode === 'remote_repository_name_mismatch' && result.existingRemoteName) {
    return t('status.publishNameMismatch', {
      existing: result.existingRemoteName,
      requested: result.requestedRemoteName
    })
  }
  const detail = result.failureMessage?.trim() || t('loreReturnDetailedError_5744')
  if (result.failureStage === 'configuration') {
    return t('status.publishConfigFailed', { detail })
  }
  if (result.failureStage === 'push') {
    return t('status.publishPushFailed', { detail })
  }
  return t('status.publishCreateFailed', { detail })
}

/** 选择 Clone 的父目录；最终仓库目录由 Rust 端安全拼接和校验。 */
export async function selectCloneParentDirectory(): Promise<string | null> {
  if (!isTauri()) {
    throw new Error(t('browserPreviewAccessLocalDirectories_2cd3'))
  }
  return open({
    directory: true,
    multiple: false,
    title: t('chooseCloneDestination')
  })
}

/** 选择 Lore 克隆接受的可选选择性同步规则文件。 */
export async function selectCloneViewFile(): Promise<string | null> {
  if (!isTauri()) {
    throw new Error(t('browserPreviewAccessLocalFiles_919d'))
  }
  return open({
    directory: false,
    multiple: false,
    title: t('chooseLoreSelectiveSyncRules_b65e')
  })
}

/** 选择 Shared Store 的设备级父目录；Lore 会自行创建远端隔离子目录。 */
export async function selectSharedStoreParentDirectory(): Promise<string | null> {
  if (!isTauri()) {
    throw new Error(t('browserPreviewAccessLocalDirectories_2cd3'))
  }
  return open({
    directory: true,
    multiple: false,
    title: t('chooseSharedStoreParentDirectory')
  })
}

/** 读取设备级 Shared Store 配置和 Rust 端只读占用统计。 */
export async function loadSharedStoreInfo(): Promise<LoreSharedStoreInfo> {
  return invokeCommand<LoreSharedStoreInfo>('lore_shared_store_info', {})
}

/**
 * 读取设备级 Shared Store 注册表。
 *
 * `includeInstances` 会逐个加载每个 Store 搜索使用它的仓库实例，成本随 Store
 * 数量增长，因此只在用户主动展开清单时开启，不进入设置页默认刷新路径。
 *
 * 注册表由 Rust 适配层解析为稳定 DTO；`instancesRequested` 会原样回传本次请求
 * 是否搜索了实例——Lore 无论是否搜索都会发送实例数组，空数组无法区分
 * “确无实例”与“未查询”。
 */
export async function loadSharedStoreRegistry(includeInstances = false): Promise<LoreSharedStoreRegistry> {
  return invokeCommand<LoreSharedStoreRegistry>('lore_shared_store_list', { includeInstances })
}

/** 创建远端对应的 Shared Store；不传 force，已有 Store 永远不会被覆盖。 */
export async function createSharedStore(
  remoteUrl: string,
  parentPath: string,
  makeDefault: boolean
): Promise<LoreOperationResult> {
  return runOperation('lore_shared_store_create', {
    remoteUrl,
    parentPath: parentPath.trim() || null,
    makeDefault
  })
}

/** 切换固定 Lore 全局配置中的自动使用开关。 */
export async function setSharedStoreUseAutomatically(enabled: boolean): Promise<LoreOperationResult> {
  return runOperation('lore_shared_store_set_use_automatically', { enabled })
}

/**
 * 依次读取状态、历史和 Branch，形成 React 能稳定消费的仓库快照。
 *
 * 顺序调用可以避免首次打开大型仓库时并发争用 Store；后续刷新仍会复用
 * Rust 适配层设置的短期 Store keep-alive。
 */
export async function loadRepositorySnapshot(repositoryPath: string, scan = false): Promise<RepositorySnapshot> {
  const status = await runOperation('lore_repository_status', {
    repositoryPath,
    scan
  })
  const changes = parseChanges(status.events)
  /*
   * 冲突类型不能从 React 发起操作时的临时状态推断。Rust 会读取真实 staged
   * Revision，即使应用重启或冲突由外部 Lore 命令产生，也能恢复当前会话。
   * 普通 Stage 也有 staged Revision；只有 Status 明确报告冲突文件时才追加查询。
   */
  const conflictSession = changes.some((file) => file.conflict) ? await loadConflictSession(repositoryPath) : null
  /*
   * Branch 列表同时提供移动指针 latest。必须先于历史读取它，才能在工作区停在旧
   * Revision 时仍从当前 Branch tip 向父节点遍历，而不是把旧 HEAD 当成历史上界。
   */
  const statusRepository = parseRepository(repositoryPath, status.events)
  const branchList = await runOperation('lore_branch_list', {
    repositoryPath,
    // Lore 仅在显式开启后附加已归档本地分支；侧栏会把它们投影到独立只读分组。
    includeArchived: true
  })
  const statusBranches = parseBranches(branchList.events, statusRepository)
  const historyAnchor =
    statusBranches.find(
      (branch) =>
        !branch.remote && Boolean(branch.latest) && (Boolean(branch.current) || branch.name === statusRepository.branch)
    )?.latest || statusRepository.revision
  const history = await runOperation('lore_revision_history', {
    repositoryPath,
    limit: 100,
    revision: historyAnchor || null
  })
  const tags = await listTags(repositoryPath)
  const config = await loadRepositoryConfig(repositoryPath)

  const repository = parseRepository(repositoryPath, status.events, config)
  const branches = parseBranches(branchList.events, repository)

  return {
    repository,
    branches,
    revisions: parseRevisions(history.events, repository, branches),
    changes,
    tags,
    conflictSession,
    loadedAt: new Date().toISOString()
  }
}

export function parseRepository(
  repositoryPath: string,
  events: LoreEvent[],
  config: RepositoryConfigValues = {}
): Repository {
  const status = eventData(events, 'repositoryStatusRevision')
  const displayPath = normalizeDisplayPath(repositoryPath)
  const pathParts = displayPath.replace(/[\\/]+$/, '').split(/[\\/]/)
  const branch = readString(status?.branchName, t('noAttachedBranch'))
  const localRevision = readNumber(status?.revisionLocalNumber)
  const remoteRevision = readNumber(status?.revisionRemoteNumber)
  const localAhead = readBoolean(status?.isLocalAhead)
  const remoteAhead = readBoolean(status?.isRemoteAhead)
  const conflictEvents = events.filter(
    (event) => event.tagName === 'repositoryStatusFile' && readBoolean(event.data.flagConflict)
  )
  const remoteAvailable = readBoolean(status?.remoteAvailable)
  const remoteAuthorized = readBoolean(status?.remoteAuthorized)
  const online = remoteAvailable && remoteAuthorized
  /*
   * `remote_url` 是“是否配置远端”的权威来源；Status 只描述本次连接结果。
   * 少数只消费 Status 的调用没有配置投影，因此成功连接本身也足以证明存在远端。
   */
  const remoteState = online ? 'online' : !config.remoteUrl ? 'local' : remoteAvailable ? 'unauthorized' : 'offline'
  const hasSyncEvidence =
    status != null && isBooleanEvidence(status.isLocalAhead) && isBooleanEvidence(status.isRemoteAhead)
  const currentBranchSyncState =
    remoteState === 'local'
      ? 'local-only'
      : remoteState !== 'online'
        ? 'unavailable'
        : !hasSyncEvidence
          ? 'unknown'
          : localAhead && remoteAhead
            ? 'diverged'
            : localAhead
              ? 'ahead'
              : remoteAhead
                ? 'behind'
                : 'synced'

  return {
    id: readString(status?.repository, stablePathId(repositoryPath)),
    name: pathParts.at(-1) || 'Lore Repository',
    branch,
    /*
     * Lore 用全零哈希表示空仓库尚无 Revision。稳定 DTO 不能把协议哨兵暴露为
     * 可查询对象，否则首次打开会把它传给 Revision History 并触发 not found。
     */
    revision: readRevisionId(status?.revision),
    path: displayPath,
    remoteUrl: config.remoteUrl,
    serverUrl: config.serverUrl,
    identity: config.identity,
    ahead: localAhead ? Math.max(1, localRevision - remoteRevision) : 0,
    behind: remoteAhead ? Math.max(1, remoteRevision - localRevision) : 0,
    currentBranchSyncState,
    online,
    remoteState,
    color: colorFromText(repositoryPath),
    conflictCount: conflictEvents.length,
    unresolvedConflictCount: conflictEvents.filter((event) => readBoolean(event.data.flagConflictUnresolved)).length
  }
}
