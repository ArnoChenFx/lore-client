import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { open, save } from '@tauri-apps/plugin-dialog'

import { t } from '../i18n'
import { isTextLikeFile, repositoryAccentFromIndex, revisionAuthorFromIdentity } from '../shared/lib'
import type {
  BinaryFilePreview,
  Branch,
  ChangeFile,
  ChangeStatus,
  ConflictAction,
  ConflictOperationKind,
  ConflictSession,
  AvailableExternalTool,
  ExternalDiffLaunchResult,
  ExternalDiffRequest,
  ExternalDiffToolPreference,
  ExternalMergeRequest,
  FileHistoryEntry,
  LoreCommandError,
  LoreCloneResult,
  LoreEvent,
  LoreFileLock,
  LoreBranchDiff,
  LoreBranchDiffChange,
  LoreBranchInfo,
  LoreBranchLatestEntry,
  LoreAuthIdentity,
  LoreDependencyGraphEdge,
  LoreDependencyGraphQuery,
  LoreDependencyGraphNode,
  LoreDependencyQuery,
  LoreDependencySelection,
  LoreLayer,
  LoreLayerAddRequest,
  LoreLayerRemoveRequest,
  LoreLink,
  LoreLinkAddRequest,
  LoreLinkUpdateRequest,
  LoreMetadataEntry,
  LoreMetadataScope,
  LoreOperationResult,
  LoreOperationStreamEvent,
  LoreRepositoryNotification,
  LoreRepositoryInstance,
  LoreDiagnosticReport,
  LoreRepositoryInitializeResult,
  LoreRepositoryPublishResult,
  LoreRevisionBisectResult,
  LoreRevisionInfo,
  LoreRuntimeInfo,
  LoreSharedStoreInfo,
  LoreCloneOptions,
  LoreTag,
  Repository,
  RepositoryConfiguration,
  RepositoryDirectoryProbe,
  RepositoryView,
  RepositoryViewApplyResult,
  RepositoryViewPreview,
  RemoteRepository,
  RepositorySnapshot,
  RevisionHistoryQuery,
  Revision,
  RevisionBranchPointer,
  RevisionFile,
  WorkingTreeDiff
} from '../types'

const ZERO_HASH_PATTERN = /^0+$/

/** 产品内置的本机 Lore 服务地址；测试它时不能依赖开发者机器上的 `.env`。 */
const BUILT_IN_SERVER_URL = 'lore://127.0.0.1:41337'

/**
 * 解析产品默认服务器地址。
 *
 * 将解析过程保持为纯函数，使“未提供覆盖值”的测试不会被项目根目录 `.env`
 * 污染；空白覆盖值同样视为未配置，避免生成无法连接的空地址。
 */
export function resolveDefaultServerUrl(environmentOverride?: string): string {
  return environmentOverride?.trim() || BUILT_IN_SERVER_URL
}

/** 订阅 Rust 适配层的实时 Lore 操作事件；浏览器演示模式返回空清理函数。 */
export async function subscribeLoreOperationStream(
  listener: (event: LoreOperationStreamEvent) => void
): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined
  return listen<LoreOperationStreamEvent>('lore://operation-stream', (event) => listener(event.payload))
}

/**
 * 连接当前仓库的真实远端通知。
 *
 * 先注册 WebView 监听再调用 Subscribe，避免遗漏上游立即发出的 subscribed 事件；
 * 清理时先请求 Lore Unsubscribe，再移除本地监听。
 */
export async function connectRepositoryNotifications(
  repositoryPath: string,
  listener: (event: LoreRepositoryNotification) => void
): Promise<() => Promise<void>> {
  if (!isTauri()) return async () => undefined
  const unlisten = await listen<LoreRepositoryNotification>('lore://repository-notification', (event) => {
    if (event.payload.repositoryPath === repositoryPath) listener(event.payload)
  })
  try {
    const status = await invoke<number>('lore_notification_subscribe', { repositoryPath })
    if (status !== 0) {
      throw new Error(t('notificationSubscriptionFailed'))
    }
  } catch (error) {
    unlisten()
    throw error
  }
  return async () => {
    try {
      await invoke<number>('lore_notification_unsubscribe', { repositoryPath })
    } finally {
      unlisten()
    }
  }
}

/** 未配置覆盖值时连接本机 Lore 服务；共享测试服务器必须由环境变量显式提供。 */
export const DEFAULT_SERVER_URL = resolveDefaultServerUrl(import.meta.env.VITE_LORE_SERVER_URL)

/**
 * 操作失败时携带 Lore 的原始状态码和事件，便于 UI 展示短提示，
 * 同时保留足够诊断信息供日志页或问题报告使用。
 */
export class LoreOperationError extends Error {
  readonly status: number
  readonly operation: string
  readonly events: LoreEvent[]

  constructor(result: LoreOperationResult) {
    super(readLoreErrorMessage(result))
    this.name = 'LoreOperationError'
    this.status = result.status
    this.operation = result.operation
    this.events = result.events
  }
}

/** 发布失败仍保留远端创建、配置写入和 Push 三个阶段的真实完成状态。 */
export class LoreRepositoryPublishError extends Error {
  readonly result: LoreRepositoryPublishResult

  constructor(result: LoreRepositoryPublishResult) {
    super(repositoryPublishFailureMessage(result))
    this.name = 'LoreRepositoryPublishError'
    this.result = result
  }
}

export function getApplicationMode(): 'tauri' | 'browser-demo' {
  return isTauri() ? 'tauri' : 'browser-demo'
}

export async function getLoreRuntimeInfo(): Promise<LoreRuntimeInfo> {
  if (!isTauri()) {
    return {
      application: 'Lore Client',
      available: false,
      integrationMode: 'browser-demo',
      loreCoreStatus: 'preview-only',
      libraryVersion: '0.8.6',
      sourceRevision: 'demo'
    }
  }

  return invoke<LoreRuntimeInfo>('lore_runtime_info')
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
  defaultIdentity?: string
): Promise<LoreRepositoryInitializeResult> {
  const initialized = await invokeCommand<LoreRepositoryInitializeResult>('lore_repository_initialize', {
    directoryPath,
    repositoryName,
    description,
    repositoryIdentity,
    defaultIdentity: defaultIdentity?.trim() || null
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

/** 查询当前 Branch 的协作锁；全 Branch 查询只在用户打开管理页时触发。 */
export async function queryFileLocks(
  repositoryPath: string,
  branch: string,
  owner?: string,
  path?: string
): Promise<LoreFileLock[]> {
  const result = await runOperation('lore_lock_file_query', {
    repositoryPath,
    branch,
    owner: owner?.trim() || null,
    path: path?.trim() || null
  })
  return parseFileLocks(result.events, branch, 'lockFileQuery')
}

/** 按明确路径批量读取协作锁，避免大型仓库在普通文件视图中执行全仓查询。 */
export async function loadFileLockStatus(
  repositoryPath: string,
  branch: string,
  paths: string[]
): Promise<LoreFileLock[]> {
  if (paths.length === 0) return []
  const result = await runOperation('lore_lock_file_status', {
    repositoryPath,
    branch,
    paths
  })
  return parseFileLocks(result.events, branch, 'lockFileStatus')
}

/** 获取协作提示锁；成功事件仍由调用方在操作中心保留。 */
export async function acquireFileLocks(
  repositoryPath: string,
  branch: string,
  paths: string[]
): Promise<LoreOperationResult> {
  return runOperation('lore_lock_file_acquire', { repositoryPath, branch, paths })
}

/** 释放当前已认证身份持有的协作提示锁。 */
export async function releaseFileLocks(
  repositoryPath: string,
  branch: string,
  paths: string[]
): Promise<LoreOperationResult> {
  return runOperation('lore_lock_file_release', { repositoryPath, branch, paths })
}

/** Lock Query 与 Status 仅在事件标签和 Branch 字段来源上不同。 */
export function parseFileLocks(events: LoreEvent[], branch: string, tagName: string): LoreFileLock[] {
  return events
    .filter((event) => event.tagName === tagName)
    .map((event) => ({
      path: readString(event.data.path, ''),
      branch: readString(event.data.branch, branch),
      owner: readString(event.data.owner, ''),
      lockedAt: readNumber(event.data.lockedAt)
    }))
    .filter((lock) => Boolean(lock.path))
}

/** 为文件增加一条依赖边，默认由 Lore 执行循环检测。 */
export async function addFileDependency(
  repositoryPath: string,
  sourcePath: string,
  dependencyPath: string,
  tags: string[],
  force = false
): Promise<LoreOperationResult> {
  return runOperation('lore_file_dependency_add', {
    repositoryPath,
    sourcePath,
    dependencyPath,
    tags,
    force
  })
}

/** 移除一条精确依赖边；传入的标签决定移除范围。 */
export async function removeFileDependency(
  repositoryPath: string,
  sourcePath: string,
  dependencyPath: string,
  tags: string[]
): Promise<LoreOperationResult> {
  return runOperation('lore_file_dependency_remove', {
    repositoryPath,
    sourcePath,
    dependencyPath,
    tags
  })
}

/** 查询当前或指定不可变 Revision 的依赖关系。 */
export async function listFileDependencies(
  repositoryPath: string,
  paths: string[],
  options: LoreDependencySelection,
  reverse = false,
  revision?: string
): Promise<LoreDependencyQuery> {
  const result = await runOperation('lore_file_dependency_list', {
    repositoryPath,
    paths,
    revision: revision?.trim() || null,
    recursive: options.recursive,
    reverse,
    tags: options.tags,
    depthLimit: options.depthLimit
  })
  return parseFileDependencies(result.events, reverse, options.recursive, options.depthLimit)
}

/** 依靠 ListFile/Entry/FileEnd 事件边界恢复稳定的按根文件分组结构。 */
export function parseFileDependencies(
  events: LoreEvent[],
  reverse: boolean,
  recursive: boolean,
  depthLimit: number
): LoreDependencyQuery {
  const groups: LoreDependencyQuery['groups'] = []
  let current: LoreDependencyQuery['groups'][number] | null = null
  for (const event of events) {
    if (event.tagName === 'fileDependencyListFile') {
      current = { path: readString(event.data.path, ''), entries: [] }
      if (current.path) groups.push(current)
      continue
    }
    if (event.tagName === 'fileDependencyListFileEnd') {
      current = null
      continue
    }
    if (event.tagName !== 'fileDependencyListEntry' || !current) continue
    const path = readString(event.data.path, '')
    if (!path) continue
    current.entries.push({
      path,
      tags: Array.isArray(event.data.tags) ? event.data.tags.map((tag) => readString(tag)).filter(Boolean) : [],
      depth: readNumber(event.data.depth)
    })
  }
  return { groups, reverse, recursive, depthLimit }
}

const FILE_DEPENDENCY_GRAPH_NODE_LIMIT = 240

type DirectDependencyBatchLoader = (paths: string[]) => Promise<LoreDependencyQuery>

/**
 * 从固定 Lore 版本的直连查询构建精确文件依赖图。
 *
 * 上游递归 List 会把传递项的深度统一简化为 1，并丢失传递边标签，因此这里按 BFS
 * 层批量查询 `recursive = false` 的直连关系。访问集合既防止循环导致无界请求，也
 * 让同一文件最多进入一个批次；节点上限用于保护大型仓库和 Tauri IPC。
 */
export async function collectFileDependencyGraph(
  rootPaths: string[],
  options: LoreDependencySelection,
  reverse: boolean,
  revision: string,
  loadDirectBatch: DirectDependencyBatchLoader,
  nodeLimit = FILE_DEPENDENCY_GRAPH_NODE_LIMIT
): Promise<LoreDependencyGraphQuery> {
  const normalizedRoots = [...new Set(rootPaths.map((path) => path.trim()).filter(Boolean))]
  const safeNodeLimit = Math.max(1, Math.floor(nodeLimit))
  const acceptedRoots = normalizedRoots.slice(0, safeNodeLimit)
  const rootSet = new Set(acceptedRoots)
  const distances = new Map(acceptedRoots.map((path) => [path, 0]))
  const expanded = new Set<string>()
  const groups: LoreDependencyQuery['groups'] = []
  const edges = new Map<string, LoreDependencyGraphEdge>()
  let frontier = acceptedRoots
  let frontierDistance = 0
  let truncated = acceptedRoots.length < normalizedRoots.length

  while (frontier.length > 0) {
    if (options.recursive && options.depthLimit > 0 && frontierDistance >= options.depthLimit) break

    const batchPaths = frontier.filter((path) => !expanded.has(path))
    if (batchPaths.length === 0) break
    batchPaths.forEach((path) => expanded.add(path))

    const batch = await loadDirectBatch(batchPaths)
    const nextFrontier: string[] = []
    for (const group of batch.groups) {
      const groupDistance = distances.get(group.path) ?? frontierDistance
      const acceptedEntries: typeof group.entries = []

      for (const entry of group.entries) {
        const existingDistance = distances.get(entry.path)
        if (existingDistance === undefined) {
          if (distances.size >= safeNodeLimit) {
            truncated = true
            continue
          }
          distances.set(entry.path, groupDistance + 1)
          nextFrontier.push(entry.path)
        } else if (groupDistance + 1 < existingDistance) {
          distances.set(entry.path, groupDistance + 1)
        }

        acceptedEntries.push({ ...entry, depth: 0 })
        const sourcePath = reverse ? entry.path : group.path
        const dependencyPath = reverse ? group.path : entry.path
        const edgeKey = `${sourcePath}\u0000${dependencyPath}`
        const existingEdge = edges.get(edgeKey)
        edges.set(edgeKey, {
          sourcePath,
          dependencyPath,
          // 同一批次理论上只有一条边；合并标签可容忍上游重复事件而不丢信息。
          tags: [...new Set([...(existingEdge?.tags ?? []), ...entry.tags])].sort()
        })
      }

      groups.push({ path: group.path, entries: acceptedEntries })
    }

    if (!options.recursive) break
    frontier = [...new Set(nextFrontier)].filter((path) => !expanded.has(path))
    frontierDistance += 1
  }

  const nodes: LoreDependencyGraphNode[] = [...distances.entries()]
    .map(([path, distance]) => ({ path, distance, root: rootSet.has(path) }))
    .sort((left, right) => left.distance - right.distance || left.path.localeCompare(right.path))

  return {
    revision,
    groups,
    nodes,
    edges: [...edges.values()].sort(
      (left, right) =>
        left.sourcePath.localeCompare(right.sourcePath) || left.dependencyPath.localeCompare(right.dependencyPath)
    ),
    reverse,
    recursive: options.recursive,
    depthLimit: options.depthLimit,
    truncated,
    nodeLimit: safeNodeLimit
  }
}

/**
 * 在同一不可变 Revision 上加载可视化所需的精确边。
 *
 * 该函数复用现有 Tauri List 命令；每个 BFS 层只发起一次批量读取，不把人类可读
 * CLI 输出当作数据源。图节点达到上限后停止扩张并返回 truncated 标记。
 */
export async function loadFileDependencyGraph(
  repositoryPath: string,
  rootPaths: string[],
  options: LoreDependencySelection,
  reverse = false,
  revision = ''
): Promise<LoreDependencyGraphQuery> {
  return collectFileDependencyGraph(rootPaths, options, reverse, revision, (paths) =>
    listFileDependencies(
      repositoryPath,
      paths,
      {
        rootFiles: paths,
        tags: options.tags,
        recursive: false,
        // 非递归查询不会消费深度，但显式传 1 可以准确表达“只读直连边”的意图。
        depthLimit: 1
      },
      reverse,
      revision
    )
  )
}

/**
 * 通过 Lore 协议读取服务器仓库目录。
 *
 * 该调用只发送列表请求，不会创建仓库、克隆内容或修改远端状态。
 */
export async function listRemoteRepositories(serverUrl: string, userId?: string): Promise<RemoteRepository[]> {
  const result = await runOperation('lore_repository_list', { serverUrl, userId: userId?.trim() || null })
  const repositories = parseRemoteRepositories(result.events)

  /*
   * 固定 Lore 版本的 Repository List 事件只携带 ID 与名称，description 位于
   * Repository Info。这里并行补齐只读详情，让服务器目录可以直接展示说明，同时
   * 保留列表作为降级结果：某个仓库暂时无权读取或详情请求失败时，不能连带隐藏
   * 服务器上其他可见仓库。
   */
  return Promise.all(
    repositories.map(async (repository) => {
      try {
        const details = await loadRemoteRepositoryInfo(serverUrl, repository.name, userId)
        return { ...repository, ...details }
      } catch {
        return repository
      }
    })
  )
}

/** Clone 前按需读取远端 Repository 的说明、默认 Branch 与创建身份。 */
export async function loadRemoteRepositoryInfo(
  serverUrl: string,
  repositoryName: string,
  userId?: string
): Promise<RemoteRepository> {
  const result = await runOperation('lore_repository_info_remote', {
    serverUrl,
    repositoryName,
    userId: userId?.trim() || null
  })
  const event = result.events.find((candidate) => candidate.tagName === 'repositoryData')
  if (!event) {
    throw new Error(t('remoteRepositoryInfoMissing'))
  }
  return {
    id: readString(event.data.id, 'unknown'),
    name: readString(event.data.name, repositoryName),
    remoteUrl: readString(event.data.remoteUrl),
    description: readString(event.data.description),
    defaultBranch: readString(event.data.defaultBranchName),
    defaultBranchId: readString(event.data.defaultBranch),
    creator: readString(event.data.creator),
    created: readNumber(event.data.created),
    // 固定 Lore 提交暂不发送权限与默认分支 tip；未来协议补充后可直接进入稳定 DTO。
    permissions: readString(event.data.permissions),
    targetRevision: readString(event.data.targetRevision)
  }
}

/** 将远端仓库克隆到用户选择的位置，并返回实际创建的目录。 */
export async function cloneRepository(
  serverUrl: string,
  repositoryName: string,
  destinationParent: string,
  directoryName: string,
  viewPath?: string,
  options: LoreCloneOptions = { useSharedStore: false },
  userId?: string
): Promise<LoreCloneResult> {
  const cloneResult = await invokeCommand<LoreCloneResult>('lore_repository_clone', {
    serverUrl,
    repositoryName,
    destinationParent,
    directoryName,
    viewPath: viewPath || null,
    targetRevision: options.revision?.trim() || null,
    bare: options.bare ?? false,
    directFileIo: options.directFileIo ?? false,
    layerRepository: options.layer?.repository.trim() || null,
    layerMetadataKey: options.layer?.metadataKey?.trim() || null,
    useSharedStore: options.useSharedStore,
    sharedStorePath: options.sharedStorePath || null,
    dependencyRootFiles: options.dependency?.rootFiles ?? [],
    dependencyTags: options.dependency?.tags ?? [],
    dependencyRecursive: options.dependency?.recursive ?? false,
    dependencyDepthLimit: options.dependency?.depthLimit ?? 0,
    userId: userId?.trim() || null
  })
  if (cloneResult.result.status !== 0) {
    throw new LoreOperationError(cloneResult.result)
  }
  return {
    ...cloneResult,
    destinationPath: normalizeDisplayPath(cloneResult.destinationPath)
  }
}

function parseRemoteRepositories(events: LoreEvent[]): RemoteRepository[] {
  return events
    .filter((event) => event.tagName === 'repositoryListEntry')
    .map((event) => ({
      id: readString(event.data.id, 'unknown'),
      name: readString(event.data.name, t('untitledRepository'))
    }))
}

function layerResourceId(sourceRepository: string, targetPath: string): string {
  return `${sourceRepository}:${targetPath}`
}

function linkResourceId(repository: string, linkPath: string): string {
  return `${repository}:${linkPath}`
}

function parseLayers(events: LoreEvent[], stagedEvents: LoreEvent[] = []): LoreLayer[] {
  const stagedCounts = new Map(
    stagedEvents
      .filter((event) => event.tagName === 'layerStagedEntry')
      .map((event) => {
        const sourceRepository = readString(event.data.sourceRepository, '')
        const targetPath = readString(event.data.targetPath, '/')
        return [layerResourceId(sourceRepository, targetPath), readNumber(event.data.stagedFileCount)] as const
      })
  )

  return events
    .filter((event) => event.tagName === 'layerEntry')
    .map((event, index) => {
      const targetPath = readString(event.data.targetPath ?? event.data.path, t('workspaceRoot'))
      const sourceRepository = readString(event.data.sourceRepository ?? event.data.repository, `layer-${index}`)
      const id = layerResourceId(sourceRepository, targetPath)
      return {
        id,
        targetPath,
        sourceRepository,
        sourcePath: readString(event.data.sourcePath, '/'),
        metadata: readString(event.data.metadata, '—'),
        revision: readString(event.data.revision, t('currentRevision_2')),
        stagedFileCount: stagedCounts.get(id) ?? 0
      }
    })
}

function parseLinks(events: LoreEvent[], stagedEvents: LoreEvent[] = []): LoreLink[] {
  const stagedCounts = new Map(
    stagedEvents
      .filter((event) => event.tagName === 'linkStagedEntry')
      .map((event) => {
        const repository = readString(event.data.repository, '')
        const linkPath = readString(event.data.path, '/')
        return [linkResourceId(repository, linkPath), readNumber(event.data.stagedFileCount)] as const
      })
  )

  return events
    .filter((event) => event.tagName === 'linkEntry')
    .map((event, index) => {
      const linkPath = readString(event.data.linkPath ?? event.data.path, t('untitledPath'))
      const repository = readString(event.data.link ?? event.data.repository, `link-${index}`)
      const flags = readNumber(event.data.flags)
      const id = linkResourceId(repository, linkPath)
      return {
        id,
        linkPath,
        repository,
        sourcePath: readString(event.data.sourcePath, '/'),
        branchName: readString(event.data.branchName ?? event.data.branch, '—'),
        revision: readString(event.data.revision, '—'),
        flags,
        disableAutoFollow: (flags & 1) !== 0,
        stagedFileCount: stagedCounts.get(id) ?? 0
      }
    })
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
  const resolvedRevisionAuthors = await resolveRevisionAuthorNames(
    repositoryPath,
    history.events,
    statusRepository.online
  )
  const tags = await listTags(repositoryPath)
  const config = await loadRepositoryConfig(repositoryPath)

  const repository = parseRepository(repositoryPath, status.events, config)
  const branches = parseBranches(branchList.events, repository)

  return {
    repository,
    branches,
    revisions: parseRevisions(history.events, repository, branches, resolvedRevisionAuthors),
    changes,
    tags,
    conflictSession,
    loadedAt: new Date().toISOString()
  }
}

/** 读取 BranchInfo、保护元数据与 Latest 指针历史，并投影成稳定 DTO。 */
export async function loadBranchCollaboration(
  repositoryPath: string,
  branch: string
): Promise<{ info: LoreBranchInfo; latest: LoreBranchLatestEntry[] }> {
  const [infoResult, protectionResult, latestResult] = await Promise.all([
    runOperation('lore_branch_info', { repositoryPath, branch }),
    runOperation('lore_branch_protection_info', { repositoryPath, branch }),
    runOperation('lore_branch_latest_list', { repositoryPath, branch, limit: 50 })
  ])
  return {
    info: parseBranchInfo(infoResult.events, protectionResult.events),
    latest: parseBranchLatest(latestResult.events)
  }
}

/** 执行只读 Branch Diff；`path` 为空时比较完整 Branch。 */
export async function loadBranchDiff(
  repositoryPath: string,
  source: string,
  target: string,
  path?: string
): Promise<LoreBranchDiff> {
  const result = await runOperation('lore_branch_diff', {
    repositoryPath,
    source,
    target,
    path: path?.trim() || null
  })
  return parseBranchDiff(result.events, source, target)
}

/** 设置真实 Branch 保护状态。 */
export async function setBranchProtected(
  repositoryPath: string,
  branch: string,
  protectedValue: boolean
): Promise<LoreOperationResult> {
  return runOperation('lore_branch_set_protected', {
    repositoryPath,
    branch,
    protected: protectedValue
  })
}

/**
 * 安全回退当前 Branch 的 LATEST 指针。
 *
 * 两个 `expected*` 值是用户确认时看到的签名；Rust 会重新读取真实状态并拒绝漂移。
 */
export async function resetBranchLatest(
  repositoryPath: string,
  branch: string,
  revision: string,
  expectedWorkspaceRevision: string,
  expectedLatest: string
): Promise<LoreOperationResult> {
  return runOperation('lore_branch_reset', {
    repositoryPath,
    branch,
    revision,
    expectedWorkspaceRevision,
    expectedLatest
  })
}

/** 读取 Revision 信息、父节点、Delta 与元数据。 */
export async function loadRevisionInfo(repositoryPath: string, revision: string): Promise<LoreRevisionInfo> {
  const result = await runOperation('lore_revision_info', {
    repositoryPath,
    revision,
    includeDelta: true,
    includeMetadata: true
  })
  return parseRevisionInfo(result.events)
}

/** 在当前 Branch 上按 Revision 编号查找精确签名。 */
export async function findRevisionByNumber(repositoryPath: string, revisionNumber: number): Promise<string> {
  const result = await runOperation('lore_revision_find', {
    repositoryPath,
    metadataKey: null,
    metadataValue: null,
    revisionNumber
  })
  return parseRevisionFind(result.events)
}

/** 在当前 Branch 上按元数据键和可选值查找精确签名。 */
export async function findRevisionByMetadata(
  repositoryPath: string,
  metadataKey: string,
  metadataValue?: string
): Promise<string> {
  const result = await runOperation('lore_revision_find', {
    repositoryPath,
    metadataKey,
    metadataValue: metadataValue?.trim() || null,
    revisionNumber: null
  })
  return parseRevisionFind(result.events)
}

export async function amendCurrentRevision(
  repositoryPath: string,
  branch: string,
  expectedRevision: string,
  message: string
): Promise<LoreOperationResult> {
  return runOperation('lore_revision_amend', { repositoryPath, branch, expectedRevision, message })
}

export async function bisectRevisionRange(
  repositoryPath: string,
  start: string,
  end: string,
  expectedRevision: string
): Promise<{ operation: LoreOperationResult; result: LoreRevisionBisectResult }> {
  const operation = await runOperation('lore_revision_bisect', {
    repositoryPath,
    start,
    end,
    expectedRevision
  })
  return { operation, result: parseRevisionBisect(operation.events) }
}

export async function restoreCurrentRevision(
  repositoryPath: string,
  expectedRevision: string,
  message: string
): Promise<LoreOperationResult> {
  return runOperation('lore_revision_restore', { repositoryPath, expectedRevision, message })
}

/**
 * 列出脱敏账户，并用 Auth 服务签发的本地 JWT 补充显示名。
 *
 * Auth List 会为同一账户返回身份根条目和多个资源授权条目，因此按认证端点分组并对
 * userId 去重。显示名解析只是增强信息：某个端点的 Token 已过期、损坏或暂时不可读
 * 时仍返回基础账户，界面继续明确回退到不可变 userId。
 */
export async function listAuthIdentities(): Promise<LoreAuthIdentity[]> {
  const result = await runOperation('lore_auth_list', {})
  const identities = parseAuthIdentities(result.events)
  const identitiesByAuthUrl = new Map<string, Set<string>>()
  for (const identity of identities) {
    const userIds = identitiesByAuthUrl.get(identity.authUrl) ?? new Set<string>()
    userIds.add(identity.userId)
    identitiesByAuthUrl.set(identity.authUrl, userIds)
  }

  const resolvedNames = new Map<string, string>()
  await Promise.all(
    [...identitiesByAuthUrl].map(async ([authUrl, userIds]) => {
      try {
        const userInfo = await runOperation('lore_auth_local_user_info', {
          authUrl,
          userIds: [...userIds]
        })
        for (const event of userInfo.events) {
          if (event.tagName !== 'authUserInfo') continue
          const userId = readString(event.data.id)
          const displayName = readString(event.data.name)
          if (userId && displayName && displayName !== userId) {
            resolvedNames.set(authIdentityKey(authUrl, userId), displayName)
          }
        }
      } catch {
        /*
         * 名称解析不能改变账户可用性。失败详情已经由底层操作流记录；这里保留账户 ID，
         * 让退出登录、仓库绑定和重新认证仍然可用。
         */
      }
    })
  )

  return identities.map((identity) => ({
    ...identity,
    displayName: resolvedNames.get(authIdentityKey(identity.authUrl, identity.userId))
  }))
}

/** 由 Lore/Rust 打开系统浏览器并完成交互认证。 */
export async function loginAuthInteractive(remoteUrl: string): Promise<LoreOperationResult> {
  return runOperation('lore_auth_login_interactive', { remoteUrl })
}

/**
 * 一次性提交 Token。
 *
 * 调用方必须在 Promise 建立后立即清空输入；服务不缓存、记录或返回 Token。
 */
export async function loginAuthWithToken(
  remoteUrl: string,
  token: string,
  tokenType: string,
  authUrl?: string
): Promise<LoreOperationResult> {
  return runOperation('lore_auth_login_with_token', {
    remoteUrl,
    token,
    tokenType,
    authUrl: authUrl?.trim() || null
  })
}

export async function logoutAuthIdentity(authUrl: string, userId: string): Promise<LoreOperationResult> {
  return runOperation('lore_auth_logout', { authUrl, userId })
}

export async function clearAuthIdentities(): Promise<LoreOperationResult> {
  return runOperation('lore_auth_clear', {})
}

/** 立即切换仓库认证身份；偏好持久化由调用方在命令成功后单独完成。 */
export async function setRepositoryAuthAccountBinding(
  repositoryPath: string,
  userId?: string,
  authUrl?: string
): Promise<void> {
  await invoke('lore_auth_repository_binding_set', {
    repositoryPath,
    userId: userId?.trim() || null,
    authUrl: authUrl?.trim() || null
  })
}

interface RepositoryConfigValues extends RepositoryConfiguration {
  serverUrl?: string
}

/**
 * 仓库连接地址和作者身份属于项目本身，不能沿用上一次打开项目的全局输入值。
 * 两个键都通过 Rust 白名单读取；空字符串表示该仓库未配置对应字段。
 */
export async function loadRepositoryConfig(repositoryPath: string): Promise<RepositoryConfigValues> {
  const remoteResult = await runOperation('lore_repository_config_get', {
    repositoryPath,
    key: 'remote_url'
  })
  const identityResult = await runOperation('lore_repository_config_get', {
    repositoryPath,
    key: 'identity'
  })
  const remoteUrl = parseRepositoryConfigValue(remoteResult.events, 'remote_url')
  const identity = parseRepositoryConfigValue(identityResult.events, 'identity')
  return {
    remoteUrl: remoteUrl || undefined,
    serverUrl: remoteUrl ? serverUrlFromRepositoryUrl(remoteUrl) : undefined,
    identity: identity || undefined
  }
}

/**
 * 原子更新仓库配置中的两个白名单字段。
 *
 * 空字符串由 Rust 适配层解释为删除对应键；返回值来自落盘后的重新读取结果，
 * 调用方仍需刷新完整仓库快照以同步服务器地址和提交身份状态。
 */
export async function updateRepositoryConfig(
  repositoryPath: string,
  identity: string,
  remoteUrl: string
): Promise<RepositoryConfiguration> {
  return invokeCommand<RepositoryConfiguration>('lore_repository_config_update', {
    repositoryPath,
    identity,
    remoteUrl
  })
}

/** 读取当前 Instance 本地 View；不存在时返回空内容而不是伪造默认规则。 */
export async function loadRepositoryView(repositoryPath: string): Promise<RepositoryView> {
  return invokeCommand<RepositoryView>('lore_repository_view_get', { repositoryPath })
}

/** 只读取不可变 Revision Tree 和文件物化状态，不写 View 或工作区。 */
export async function previewRepositoryView(
  repositoryPath: string,
  revision: string,
  content: string
): Promise<RepositoryViewPreview> {
  return invokeCommand<RepositoryViewPreview>('lore_repository_view_preview', {
    repositoryPath,
    revision,
    content
  })
}

/** 原子替换 View 并通过 Lore Sync 完成实例物化状态协调。 */
export async function applyRepositoryView(
  repositoryPath: string,
  revision: string,
  content: string
): Promise<RepositoryViewApplyResult> {
  return invokeCommand<RepositoryViewApplyResult>('lore_repository_view_apply', {
    repositoryPath,
    revision,
    content
  })
}

export async function stagePaths(repositoryPath: string, paths: string[]): Promise<LoreOperationResult> {
  return runOperation('lore_stage', { repositoryPath, paths })
}

export async function unstagePaths(repositoryPath: string, paths: string[]): Promise<LoreOperationResult> {
  return runOperation('lore_unstage', { repositoryPath, paths })
}

/** 读取当前锚点 Revision 与工作区文件系统之间的真实 unified diff。 */
export async function loadWorkingTreeDiff(
  repositoryPath: string,
  paths: string[],
  options: {
    contextLines: number
    ignoreWhitespaceEol: boolean
    ignoreWhitespaceInline: boolean
  } = { contextLines: 3, ignoreWhitespaceEol: false, ignoreWhitespaceInline: false }
): Promise<WorkingTreeDiff[]> {
  const result = await runOperation('lore_workspace_diff', {
    repositoryPath,
    paths,
    contextLines: options.contextLines,
    ignoreWhitespaceEol: options.ignoreWhitespaceEol,
    ignoreWhitespaceInline: options.ignoreWhitespaceInline
  })
  return parseWorkingTreeDiffs(result.events)
}

/**
 * 读取目标 Revision 相对第一父 Revision（或空树）的完整文件差异。
 *
 * 空路径数组表示比较全部路径；根 Revision 使用 `null` 来源，Rust 适配层会
 * 显式读取不可变 Revision Tree，不能回退到当前工作区锚点。
 */
export async function loadRevisionDiff(
  repositoryPath: string,
  sourceRevision: string | null,
  targetRevision: string,
  paths: string[] = [],
  options: {
    contextLines: number
    ignoreWhitespaceEol: boolean
    ignoreWhitespaceInline: boolean
  } = { contextLines: 3, ignoreWhitespaceEol: false, ignoreWhitespaceInline: false }
): Promise<WorkingTreeDiff[]> {
  const result = await runOperation('lore_revision_diff', {
    repositoryPath,
    sourceRevision,
    targetRevision,
    paths,
    contextLines: options.contextLines,
    ignoreWhitespaceEol: options.ignoreWhitespaceEol,
    ignoreWhitespaceInline: options.ignoreWhitespaceInline
  })
  return parseWorkingTreeDiffs(result.events)
}

interface LoreRevisionChangeResult {
  path: string
  sourcePath?: string
  action: string
  size: number
}

/**
 * 读取 Revision 的轻量文件变化清单，不请求任何文件内容或 unified patch。
 *
 * Rust 只比较不可变 Revision Tree 的路径和内容地址；完整 Diff 随后必须通过
 * `loadRevisionDiff(..., [path])` 为当前主要选择按需读取。
 */
export async function loadRevisionChanges(
  repositoryPath: string,
  sourceRevision: string | null,
  targetRevision: string
): Promise<ChangeFile[]> {
  const changes = await invokeCommand<LoreRevisionChangeResult[]>('lore_revision_changes', {
    repositoryPath,
    sourceRevision,
    targetRevision
  })
  return changes.map((change, index) => {
    const fullPath = change.path.replaceAll('\\', '/')
    const separatorIndex = fullPath.lastIndexOf('/')
    const action = change.action.toLocaleLowerCase()
    const status: ChangeStatus =
      action === 'add' || action === 'copy'
        ? 'added'
        : action === 'delete'
          ? 'deleted'
          : action === 'move'
            ? 'renamed'
            : 'modified'
    return {
      id: fullPath || `revision-change-${index}`,
      path: separatorIndex >= 0 ? fullPath.slice(0, separatorIndex) : '.',
      name: separatorIndex >= 0 ? fullPath.slice(separatorIndex + 1) : fullPath,
      status,
      staged: false,
      additions: 0,
      deletions: 0,
      binary: !isTextLikeFile(fullPath),
      size: formatBytes(change.size),
      previousPath: change.sourcePath?.replaceAll('\\', '/') || undefined
    }
  })
}

/** Rust 只读 Revision Tree 命令返回的最小传输结构。 */
interface LoreRevisionFileResult {
  path: string
  size: number
}

/**
 * 读取指定 Revision 的完整已提交文件集合。
 *
 * 与 `loadRevisionDiff` 分离后，“文件树”不会再错误复用本次变更列表，也不会
 * 从当前工作区状态补文件。路径在此转换为稳定前端 DTO，组件不依赖 Lore Node。
 */
export async function loadRevisionFiles(repositoryPath: string, revision: string): Promise<RevisionFile[]> {
  const files = await invokeCommand<LoreRevisionFileResult[]>('lore_revision_files', {
    repositoryPath,
    revision
  })
  return files.map((file, index) => {
    const fullPath = file.path.replaceAll('\\', '/')
    const separatorIndex = fullPath.lastIndexOf('/')
    return {
      id: `revision-tree-file:${fullPath || index}`,
      path: separatorIndex >= 0 ? fullPath.slice(0, separatorIndex) : '.',
      name: separatorIndex >= 0 ? fullPath.slice(separatorIndex + 1) : fullPath,
      size: formatBytes(file.size),
      binary: !isTextLikeFile(fullPath)
    }
  })
}

/**
 * 按需读取一个工作区或不可变 Revision 文件的二进制预览。
 *
 * `revision` 为空表示工作区真实文件；非空时 Rust 会从该 Revision Tree 的内容地址
 * 读取。调用方只在用户选中支持的图片/PDF/游戏资产后调用，避免完整 Diff 批量传输资产。
 */
export async function loadBinaryFilePreview(
  repositoryPath: string,
  path: string,
  revision?: string
): Promise<BinaryFilePreview> {
  return invokeCommand<BinaryFilePreview>('lore_file_preview', {
    repositoryPath,
    path,
    revision
  })
}

/**
 * 把 Lore 的 Revision Diff 事件投影为文件浏览器需要的稳定 DTO。
 *
 * unified diff 的文件头不属于增删内容，统计时必须排除 `---` / `+++`；
 * 二进制只服从 Lore 的内容 marker，不能再根据扩展名隐藏未知文本类型。
 */
export function revisionDiffsToChangeFiles(diffs: readonly WorkingTreeDiff[]): ChangeFile[] {
  return diffs.map((diff, index) => {
    const fullPath = diff.path.replaceAll('\\', '/')
    const separatorIndex = fullPath.lastIndexOf('/')
    const action = diff.action.toLocaleLowerCase()
    const status: ChangeStatus =
      action === 'add' || action === 'copy'
        ? 'added'
        : action === 'delete'
          ? 'deleted'
          : action === 'move' || action === 'rename'
            ? 'renamed'
            : 'modified'
    const patchLines = diff.patch.split(/\r?\n/)

    return {
      id: `revision-file:${fullPath || index}`,
      path: separatorIndex >= 0 ? fullPath.slice(0, separatorIndex) : '.',
      name: separatorIndex >= 0 ? fullPath.slice(separatorIndex + 1) : fullPath,
      status,
      staged: false,
      additions: patchLines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
      deletions: patchLines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
      /*
       * Lore 已经按真实内容识别二进制。只要没有明确 marker，就不能再因为 `.gd`
       * 或无扩展名等未列入白名单的路径把内容隐藏；空补丁表示零字节结构变化。
       */
      binary: diff.patch.includes('Binary files differ')
    }
  })
}

/** 读取 Lore 文件历史，并保留可用于关联主历史列表的完整 Revision ID。 */
export async function loadFileHistory(
  repositoryPath: string,
  path: string,
  start?: {
    branch?: string
    revision?: string
  }
): Promise<FileHistoryEntry[]> {
  /*
   * Lore 明确禁止同时指定 revision 与 branch。历史 Inspector 优先使用精确
   * Revision；只有工作区文件历史没有 Revision 起点时才从当前 Branch latest 查询。
   */
  const revision = start?.revision?.trim() || null
  const result = await runOperation('lore_file_history', {
    repositoryPath,
    path,
    branch: revision ? null : start?.branch?.trim() || null,
    revision,
    length: 100
  })
  return parseFileHistory(result.events)
}

/** 丢弃明确选择的工作区文件变化；新增文件也由 Lore 在限定路径内清理。 */
export async function discardWorkspaceFiles(
  repositoryPath: string,
  paths: string[],
  revision: string
): Promise<LoreOperationResult> {
  return runOperation('lore_discard_workspace_files', {
    repositoryPath,
    paths,
    revision
  })
}

/** 将指定仓库相对路径恢复到目标 Revision，并保留 Lore 的完整事件结果。 */
export async function resetFilesToRevision(
  repositoryPath: string,
  paths: string[],
  revision: string
): Promise<LoreOperationResult> {
  return runOperation('lore_file_reset', {
    repositoryPath,
    paths,
    revision
  })
}

export async function commitRevision(
  repositoryPath: string,
  message: string,
  defaultIdentity?: string
): Promise<LoreOperationResult> {
  return runOperation('lore_commit', {
    repositoryPath,
    message,
    defaultIdentity: defaultIdentity?.trim() || null
  })
}

export async function syncRepository(
  repositoryPath: string,
  dependency: LoreDependencySelection = { rootFiles: [], tags: [], recursive: false, depthLimit: 0 }
): Promise<LoreOperationResult> {
  return runOperation('lore_sync', {
    repositoryPath,
    dependencyRootFiles: dependency.rootFiles,
    dependencyTags: dependency.tags,
    dependencyRecursive: dependency.recursive,
    dependencyDepthLimit: dependency.depthLimit
  })
}

export async function pushBranch(repositoryPath: string, branch?: string): Promise<LoreOperationResult> {
  return runOperation('lore_push', {
    repositoryPath,
    branch: branch || null
  })
}

export async function switchBranch(
  repositoryPath: string,
  branch: string,
  revision?: string
): Promise<LoreOperationResult> {
  return runOperation('lore_branch_switch', {
    repositoryPath,
    branch,
    /*
     * 同一 Branch 上的旧工作区锚点不能依赖空 Revision Switch 自动前进；
     * Branch 检出入口应传入列表快照中的精确 latest。
     */
    revision: revision?.trim() || null
  })
}

/**
 * 把当前实例同步到指定 Branch 的目标 Revision。
 *
 * Lore 会保留 Branch latest 指针；该操作改变的是实例锚点和工作区，并非 Git
 * detached HEAD。Rust 端不会启用 reset/force，因此 Stage 内容仍受保护。
 */
export async function checkoutRevision(
  repositoryPath: string,
  branch: string,
  revision: string
): Promise<LoreOperationResult> {
  return runOperation('lore_revision_checkout', {
    repositoryPath,
    branch,
    revision
  })
}

/**
 * 从明确的来源 Branch/Revision 创建并附着新 Branch。
 *
 * 原生组合命令负责来源切换和失败恢复；调用方同时传入当前锚点，避免创建失败后
 * 把工作区意外留在被右击的来源 Branch。
 */
export async function createBranchFromSource(
  repositoryPath: string,
  branch: string,
  sourceBranch: string,
  sourceRevision: string,
  previousBranch: string,
  previousRevision: string
): Promise<LoreOperationResult> {
  return runOperation('lore_branch_create_from', {
    repositoryPath,
    branch,
    sourceBranch,
    sourceRevision,
    previousBranch,
    previousRevision
  })
}

/** 读取 Lore 仓库共享元数据中的客户端标签。 */
export async function listTags(repositoryPath: string): Promise<LoreTag[]> {
  return invokeCommand<LoreTag[]>('lore_tag_list', { repositoryPath })
}

/** 在精确 Branch/Revision 上创建仓库共享标签。 */
export async function createTag(
  repositoryPath: string,
  name: string,
  branch: string,
  revision: string,
  message: string
): Promise<LoreTag> {
  return invokeCommand<LoreTag>('lore_tag_create', {
    repositoryPath,
    name,
    branch,
    revision,
    message
  })
}

/** 修改标签名称或说明，目标 Revision 保持不变。 */
export async function updateTag(
  repositoryPath: string,
  tagId: string,
  name: string,
  message: string
): Promise<LoreTag> {
  return invokeCommand<LoreTag>('lore_tag_update', {
    repositoryPath,
    tagId,
    name,
    message
  })
}

/** 删除稳定 ID 对应的全部标签元数据记录。 */
export async function deleteTag(repositoryPath: string, tagId: string): Promise<void> {
  await invokeCommand<void>('lore_tag_delete', { repositoryPath, tagId })
}

/** 把目标 Revision 的变更应用到当前 Branch，并由 Lore 在无冲突时自动提交。 */
export async function cherryPickRevision(repositoryPath: string, revision: string): Promise<LoreOperationResult> {
  return runOperation('lore_revision_cherry_pick', {
    repositoryPath,
    revision
  })
}

/** 在当前 Branch 创建撤销目标 Revision 的新 Revision。 */
export async function revertRevision(repositoryPath: string, revision: string): Promise<LoreOperationResult> {
  return runOperation('lore_revision_revert', {
    repositoryPath,
    revision
  })
}

/** 把指定源 Branch 合并到当前 Branch，并在无冲突时自动创建合并 Revision。 */
export async function mergeBranch(repositoryPath: string, branch: string): Promise<LoreOperationResult> {
  return runOperation('lore_branch_merge', { repositoryPath, branch })
}

/** 读取真实 staged Revision 对应的冲突会话；没有进行中操作时返回 null。 */
export async function loadConflictSession(repositoryPath: string): Promise<ConflictSession | null> {
  return invokeCommand<ConflictSession | null>('lore_conflict_session', { repositoryPath })
}

/**
 * 执行一个真实冲突动作。
 *
 * 文件级动作由 Rust 再次验证非空仓库相对路径；Abort 为仓库级动作并忽略 paths。
 * Lore Core 还会校验 staged State 类型，旧 UI 快照无法把动作误发到另一类冲突。
 */
export async function runConflictAction(
  repositoryPath: string,
  operation: Exclude<ConflictOperationKind, 'unknown'>,
  action: ConflictAction,
  paths: string[] = []
): Promise<LoreOperationResult> {
  return runOperation('lore_conflict_action', {
    repositoryPath,
    operation,
    action,
    paths
  })
}

/** 归档本地 Branch；联网模式下 Lore 会同步归档远端指针。 */
export async function archiveBranch(repositoryPath: string, branch: string): Promise<LoreOperationResult> {
  return runOperation('lore_branch_archive', { repositoryPath, branch })
}

export async function listLayers(repositoryPath: string): Promise<LoreLayer[]> {
  const [result, staged] = await Promise.all([
    runOperation('lore_layer_list', { repositoryPath }),
    runOperation('lore_layer_list_staged', { repositoryPath })
  ])
  return parseLayers(result.events, staged.events)
}

export async function addLayer(repositoryPath: string, request: LoreLayerAddRequest): Promise<LoreOperationResult> {
  return runOperation('lore_layer_add', {
    repositoryPath,
    targetPath: request.targetPath,
    sourceRepository: request.sourceRepository,
    sourcePath: request.sourcePath,
    metadata: request.metadata?.trim() || null
  })
}

export async function removeLayer(
  repositoryPath: string,
  request: LoreLayerRemoveRequest
): Promise<LoreOperationResult> {
  return runOperation('lore_layer_remove', {
    repositoryPath,
    targetPath: request.targetPath,
    sourceRepository: request.sourceRepository,
    purge: request.purge
  })
}

export async function listLinks(repositoryPath: string): Promise<LoreLink[]> {
  const [result, staged] = await Promise.all([
    runOperation('lore_link_list', { repositoryPath }),
    runOperation('lore_link_list_staged', { repositoryPath })
  ])
  return parseLinks(result.events, staged.events)
}

export async function addLink(repositoryPath: string, request: LoreLinkAddRequest): Promise<LoreOperationResult> {
  return runOperation('lore_link_add', {
    repositoryPath,
    link: request.repositoryUrl,
    linkPath: request.linkPath,
    sourcePath: request.sourcePath,
    pin: request.pin?.trim() || null,
    disableBranching: request.disableBranching
  })
}

export async function updateLink(repositoryPath: string, request: LoreLinkUpdateRequest): Promise<LoreOperationResult> {
  return runOperation('lore_link_update', {
    repositoryPath,
    linkPath: request.linkPath,
    pin: request.pin?.trim() || null
  })
}

export async function removeLink(repositoryPath: string, linkPath: string): Promise<LoreOperationResult> {
  return runOperation('lore_link_remove', { repositoryPath, linkPath })
}

export async function verifyRepository(repositoryPath: string): Promise<LoreOperationResult> {
  return runOperation('lore_repository_verify', { repositoryPath, path: null, heal: false })
}

/** 对指定路径执行只读验证或用户确认后的受控修复。 */
export async function verifyRepositoryPath(
  repositoryPath: string,
  path: string,
  heal = false
): Promise<LoreDiagnosticReport> {
  const result = await runOperation('lore_repository_verify', {
    repositoryPath,
    path: path.trim() || null,
    heal
  })
  return parseDiagnosticReport(result)
}

/** 验证明确 Fragment；heal 只在高级诊断确认流程中传入。 */
export async function verifyRepositoryFragment(
  repositoryPath: string,
  hash: string,
  context = '',
  heal = false
): Promise<LoreDiagnosticReport> {
  return parseDiagnosticReport(
    await runOperation('lore_repository_verify_fragment', {
      repositoryPath,
      hash,
      context: context.trim() || null,
      heal
    })
  )
}

/** 读取受深度限制的 Repository State 诊断树。 */
export async function dumpRepositoryState(
  repositoryPath: string,
  revision: string,
  path: string,
  maxDepth: number
): Promise<LoreDiagnosticReport> {
  return parseDiagnosticReport(
    await runOperation('lore_repository_dump', {
      repositoryPath,
      revision: revision.trim() || null,
      path: path.trim() || null,
      maxDepth
    })
  )
}

/** 读取全部本地 Instance，并保留 Core 判定的 stale 标记。 */
export async function listRepositoryInstances(repositoryPath: string): Promise<LoreRepositoryInstance[]> {
  const result = await runOperation('lore_repository_instance_list', { repositoryPath })
  return result.events
    .filter((event) => event.tagName === 'repositoryInstance')
    .map((event) => ({
      id: readString(event.data.instanceId),
      path: normalizeDisplayPath(readString(event.data.path)),
      branchName: readString(event.data.branchName),
      branchId: readString(event.data.branch),
      revision: readString(event.data.revision),
      stale: readBoolean(event.data.stale)
    }))
}

export async function pruneRepositoryInstances(repositoryPath: string): Promise<LoreOperationResult> {
  return runOperation('lore_repository_instance_prune', { repositoryPath })
}

export async function updateRepositoryInstancePath(repositoryPath: string): Promise<LoreOperationResult> {
  return runOperation('lore_repository_instance_update_path', { repositoryPath })
}

/** 把 Lore 诊断事件收敛成只含类型、摘要与详情的稳定展示结构。 */
export function parseDiagnosticReport(result: LoreOperationResult): LoreDiagnosticReport {
  const findings = result.events
    .filter((event) => !['end', 'complete'].includes(event.tagName))
    .map((event) => {
      const data = event.data
      const error = event.tagName === 'error' || Boolean(readString(data.error))
      const summary =
        readString(data.message) ||
        readString(data.path) ||
        readString(data.hash) ||
        readString(data.revision) ||
        event.tagName
      return {
        kind: event.tagName,
        summary,
        detail: Object.keys(data).length > 0 ? JSON.stringify(data, null, 2) : '',
        error
      }
    })
  return { operation: result.operation, durationMs: result.durationMs, findings }
}

export async function collectRepositoryGarbage(repositoryPath: string): Promise<LoreOperationResult> {
  return runOperation('lore_repository_gc', { repositoryPath })
}

/** 读取四类 Lore 元数据，并隐藏二进制原始载荷。 */
export async function loadMetadata(
  repositoryPath: string,
  scope: LoreMetadataScope,
  target?: string,
  revision?: string
): Promise<LoreMetadataEntry[]> {
  const result = await runOperation('lore_metadata_list', {
    repositoryPath,
    scope,
    target: target?.trim() || null,
    revision: revision?.trim() || null
  })
  return parseMetadataEntries(result.events)
}

/** 供事件适配测试复用的纯元数据投影。 */
export function parseMetadataEntries(events: LoreEvent[]): LoreMetadataEntry[] {
  return events.filter((event) => event.tagName === 'metadata').map((event) => parseMetadataEntry(event))
}

function parseMetadataEntry(event: LoreEvent): LoreMetadataEntry {
  const rawValue = isRecord(event.data.value) ? event.data.value : {}
  const rawType = readString(rawValue.tagName, 'unknown').toLowerCase()
  const allowedTypes: LoreMetadataEntry['type'][] = [
    'address',
    'boolean',
    'binary',
    'context',
    'hash',
    'numeric',
    'string'
  ]
  const type = allowedTypes.includes(rawType as LoreMetadataEntry['type'])
    ? (rawType as LoreMetadataEntry['type'])
    : 'unknown'
  const data = rawValue.data
  let value: string
  if (type === 'binary') {
    const byteCount = Array.isArray(data) ? data.length : 0
    value = t('status.binaryMetadataSummary', { count: byteCount })
  } else if (typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean') {
    value = String(data)
  } else {
    value = data == null ? '' : JSON.stringify(data)
  }
  return { key: readString(event.data.key), type, value }
}

/** 按显式条件重读 Revision History，不触碰工作区状态或当前选区。 */
export async function loadRevisionHistory(
  repository: Repository,
  branches: Branch[],
  query: RevisionHistoryQuery
): Promise<Revision[]> {
  const result = await runOperation('lore_revision_history', {
    repositoryPath: repository.path,
    limit: Math.max(1, Math.min(1_000, query.limit)),
    revision: query.revision?.trim() || null,
    branch: query.branch?.trim() || null,
    date: query.beforeDate || null,
    onlyBranch: query.onlyBranch
  })
  const resolvedRevisionAuthors = await resolveRevisionAuthorNames(repository.path, result.events, repository.online)
  return parseRevisions(result.events, repository, branches, resolvedRevisionAuthors)
}

/** 使用系统文件管理器定位当前 Lore 工作区。 */
export async function openWorkspace(repositoryPath: string): Promise<void> {
  await invoke('lore_open_workspace', { repositoryPath })
}

/** 使用系统文件管理器选中仓库内文件；删除文件会由原生层退回到所在目录。 */
export async function revealWorkspaceFile(repositoryPath: string, relativePath: string): Promise<void> {
  await invoke('lore_reveal_workspace_file', {
    repositoryPath,
    relativePath
  })
}

/** 使用系统关联应用打开仓库内的现有文件。 */
export async function openWorkspaceFile(repositoryPath: string, relativePath: string): Promise<void> {
  await invokeCommand<void>('lore_open_workspace_file', {
    repositoryPath,
    relativePath
  })
}

/**
 * 使用用户配置的原生可执行文件比较两个真实文件版本。
 *
 * 请求中的参数模板保持结构化数组；Rust 负责校验仓库路径、物化不可变版本并
 * 直接启动进程，前端不拼接命令行或 Shell 文本。
 */
export async function openExternalDiff(request: ExternalDiffRequest): Promise<ExternalDiffLaunchResult> {
  return invokeCommand<ExternalDiffLaunchResult>('lore_open_external_diff', {
    repositoryPath: request.repositoryPath,
    tool: request.tool,
    before: request.before,
    after: request.after
  })
}

/** 由 Rust 使用与启动阶段相同的规则探测显式路径和系统 PATH。 */
export async function detectExternalTools(tools: ExternalDiffToolPreference[]): Promise<AvailableExternalTool[]> {
  if (!isTauri()) return []
  return invokeCommand<AvailableExternalTool[]>('lore_detect_external_tools', { tools })
}

/** 启动四路外部 Merge；共同祖先解析与历史内容物化全部留在 Rust 边界。 */
export async function openExternalMerge(request: ExternalMergeRequest): Promise<ExternalDiffLaunchResult> {
  return invokeCommand<ExternalDiffLaunchResult>('lore_open_external_merge', { ...request })
}

/** 把真实 unified patch 交给系统关联应用。 */
export async function openPatchExternally(fileName: string, patch: string): Promise<string> {
  return invokeCommand<string>('lore_open_patch', { fileName, patch })
}

/** 通过原生保存对话框选择位置，并由 Rust 完成补丁写入。 */
export async function savePatchFile(suggestedName: string, patch: string): Promise<string | null> {
  const destinationPath = await save({
    title: t('saveWorkspacePatch'),
    defaultPath: suggestedName.endsWith('.patch') ? suggestedName : `${suggestedName}.patch`,
    filters: [{ name: t('unifiedDiffPatch'), extensions: ['patch', 'diff'] }]
  })
  if (!destinationPath) {
    return null
  }
  await invokeCommand<void>('lore_write_patch_file', {
    destinationPath,
    patch
  })
  return destinationPath
}

/** 选择外部 Diff/Merge 工具的可执行文件；命令名仍可直接在设置输入框中填写。 */
export async function selectExternalDiffExecutable(): Promise<string | null> {
  if (!isTauri()) {
    throw new Error(t('browserPreviewAccessLocalFiles_919d'))
  }
  const selection = await open({
    directory: false,
    multiple: false,
    title: t('chooseExternalDiffExecutable')
  })
  return typeof selection === 'string' ? selection : null
}

/** 将选中路径或其扩展名安全追加到 `.loreignore`。 */
export async function ignoreWorkspacePaths(
  repositoryPath: string,
  paths: string[],
  byExtension: boolean
): Promise<string[]> {
  return invokeCommand<string[]>('lore_ignore_paths', {
    repositoryPath,
    paths,
    byExtension
  })
}

async function runOperation(command: string, args: Record<string, unknown>): Promise<LoreOperationResult> {
  try {
    const result = await invoke<LoreOperationResult>(command, args)
    if (result.status !== 0) {
      throw new LoreOperationError(result)
    }
    return result
  } catch (error) {
    if (error instanceof LoreOperationError || error instanceof Error) {
      throw error
    }

    // Tauri 会把可序列化的 Rust 错误对象直接交给前端，需要在这里恢复成 Error。
    const commandError = error as Partial<LoreCommandError>
    throw new Error(localizeCommandError(commandError, command))
  }
}

/** 把直接返回 DTO 的 Tauri 命令错误统一恢复为标准 Error。 */
async function invokeCommand<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    if (error instanceof Error) {
      throw error
    }
    const commandError = error as Partial<LoreCommandError>
    throw new Error(localizeCommandError(commandError, command))
  }
}

/**
 * Rust 错误消息保留诊断细节，但稳定错误码必须先映射成当前界面语言。
 * 这里仅覆盖客户端能够给出明确恢复建议的错误；其余错误继续保留上游详情。
 */
function localizeCommandError(error: Partial<LoreCommandError>, command: string): string {
  if (error.code === 'invalid_clone_target') {
    return t('invalidCloneTarget')
  }
  if (error.code === 'invalid_clone_layer_metadata') {
    return t('invalidCloneLayerMetadata')
  }
  if (error.code === 'invalid_clone_layer_repository') {
    return t('invalidCloneLayerRepository')
  }
  if (error.code === 'clone_layer_repository_required') {
    return t('cloneLayerRepositoryRequired')
  }
  if (error.code === 'clone_bare_materialization_options') {
    return t('cloneBareMaterializationOptions')
  }
  if (error.code === 'composition_field_required') {
    return t('compositionFieldRequired')
  }
  if (error.code === 'composition_field_invalid') {
    return t('compositionFieldInvalid')
  }
  if (error.code === 'invalid_repository_relative_path') {
    return t('invalidRepositoryRelativePath')
  }
  if (error.code === 'fragment_identifier_invalid') {
    return t('fragmentIdentifierInvalid')
  }
  if (error.code === 'metadata_scope_invalid') {
    return t('metadataScopeInvalid')
  }
  if (error.code === 'metadata_revision_required') {
    return t('metadataRevisionRequired')
  }
  if (error.code === 'unknown_conflict_operation') {
    return t('conflictOperationUnknownError')
  }
  if (error.code === 'conflict_state_unavailable') {
    return t('conflictStateUnavailable')
  }
  if (error.code === 'conflict_paths_required') {
    return t('selectConflictFilesToContinue')
  }
  if (error.code === 'repository_view_workspace_dirty') {
    return t('cleanWorkspaceBeforeApplyingView')
  }
  if (error.code === 'repository_view_revision_changed') {
    return t('repositoryViewRevisionChanged')
  }
  if (error.code === 'repository_view_invalid') {
    return t('repositoryViewContainsErrors')
  }
  if (error.code === 'repository_view_too_large') {
    return t('repositoryViewTooLarge')
  }
  if (error.code === 'repository_view_invalid_utf8') {
    return t('repositoryViewMustBeUtf8')
  }
  if (error.code === 'repository_view_status_unavailable') {
    return t('repositoryViewStatusUnavailable')
  }
  if (error.code === 'repository_view_sync_failed') {
    return t('repositoryViewSyncFailedAndRolledBack')
  }
  if (error.code === 'repository_view_dematerialize_failed') {
    return t('repositoryViewDematerializeFailedAndRolledBack')
  }
  if (
    [
      'repository_view_read_failed',
      'repository_view_parent_missing',
      'repository_view_temporary_create_failed',
      'repository_view_temporary_write_failed',
      'repository_view_backup_failed',
      'repository_view_replace_failed',
      'repository_view_cache_release_failed'
    ].includes(error.code ?? '')
  ) {
    return t('repositoryViewStorageFailed')
  }
  return error.message ?? t('status.commandFailed', { command })
}

function readLoreErrorMessage(result: LoreOperationResult): string {
  const errorEvent = result.events.find((event) => event.tagName === 'error')
  if (typeof errorEvent?.data.errorInner === 'string') {
    return errorEvent.data.errorInner
  }

  const complete = result.events.find((event) => event.tagName === 'complete')
  const detail = complete?.data.error
  if (isRecord(detail)) {
    for (const key of ['message', 'inner', 'context']) {
      if (typeof detail[key] === 'string' && detail[key]) {
        return detail[key]
      }
    }
  }
  return t('status.operationFailedWithStatus', {
    operation: result.operation,
    status: result.status
  })
}

function parseRepository(repositoryPath: string, events: LoreEvent[], config: RepositoryConfigValues = {}): Repository {
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
    online,
    remoteState,
    color: colorFromText(repositoryPath),
    conflictCount: conflictEvents.length,
    unresolvedConflictCount: conflictEvents.filter((event) => readBoolean(event.data.flagConflictUnresolved)).length
  }
}

function parseBranches(events: LoreEvent[], repository: Repository): Branch[] {
  const branches = events
    .filter((event) => event.tagName === 'branchListEntry')
    .map((event): Branch => {
      const remote = readString(event.data.location).toLowerCase() === 'remote'
      const name = readString(event.data.name, t('untitledBranch'))
      const branchPoints = Array.isArray(event.data.stack)
        ? event.data.stack
            .filter(isRecord)
            .map((point) => ({
              branch: readString(point.branch),
              revision: readString(point.revision)
            }))
            .filter((point) => point.revision.length > 0)
        : []
      return {
        id: `${remote ? 'remote' : 'local'}:${readString(event.data.id, name)}`,
        name,
        // 新建空仓库的 Branch Latest 同样是全零哨兵，不应成为历史查询锚点。
        latest: readRevisionId(event.data.latest),
        current: readBoolean(event.data.isCurrent),
        remote,
        archived: readBoolean(event.data.archived),
        branchPoints,
        author: readString(event.data.creator, remote ? t('remote') : t('local'))
      }
    })

  // 某些离线状态只返回当前 Branch 而没有列表事件，仍应保留可操作的当前指针。
  if (!branches.some((branch) => branch.current) && repository.branch) {
    branches.unshift({
      id: `local:${repository.branch}`,
      name: repository.branch,
      current: true
    })
  }
  return branches
}

function parseBranchInfo(infoEvents: LoreEvent[], protectionEvents: LoreEvent[]): LoreBranchInfo {
  const data = eventData(infoEvents, 'branchInfo') ?? {}
  const protection = protectionEvents.find(
    (event) => event.tagName === 'metadata' && readString(event.data.key) === 'protect'
  )
  return {
    id: readString(data.id),
    name: readString(data.name),
    category: readString(data.category),
    latest: readString(data.latest),
    latestRemote: readString(data.latestRemote),
    parent: readString(data.parent),
    branchPoint: readString(data.branchPoint),
    creator: readString(data.creator),
    created: readNumber(data.created),
    archived: readBoolean(data.archived),
    protected: readBoolean(readMetadataValue(protection?.data.value))
  }
}

function parseBranchLatest(events: LoreEvent[]): LoreBranchLatestEntry[] {
  return events
    .filter((event) => event.tagName === 'branchLatestListEntry')
    .map((event) => ({
      branch: readString(event.data.branch),
      revision: readString(event.data.revision)
    }))
    .filter((entry) => entry.revision.length > 0)
}

function parseBranchDiffNode(value: unknown): LoreBranchDiffChange {
  const data = isRecord(value) ? value : {}
  return {
    path: readString(data.path),
    action: readString(data.action, 'modify').toLowerCase(),
    automerged: readBoolean(data.automerged)
  }
}

function parseBranchDiff(events: LoreEvent[], source: string, target: string): LoreBranchDiff {
  const changes = events
    .filter((event) => event.tagName === 'branchDiffChange')
    .map((event) => parseBranchDiffNode(event.data.change))
    .filter((change) => change.path.length > 0)
  const conflicts = events
    .filter((event) => event.tagName === 'branchDiffConflict')
    .map((event) => {
      const sourceChange = parseBranchDiffNode(event.data.sourceChange)
      const targetChange = parseBranchDiffNode(event.data.targetChange)
      return {
        path: sourceChange.path || targetChange.path,
        source: sourceChange,
        target: targetChange
      }
    })
    .filter((conflict) => conflict.path.length > 0)
  return { source, target, changes, conflicts }
}

function parseRevisionInfo(events: LoreEvent[]): LoreRevisionInfo {
  const data = eventData(events, 'revisionInfo') ?? {}
  const parentIds = (Array.isArray(data.parent) ? data.parent : [])
    .map((parent) => readString(parent))
    .filter((parent) => parent.length > 0 && !ZERO_HASH_PATTERN.test(parent))
  const metadata: Record<string, string | number | boolean> = {}
  for (const event of events.filter((item) => item.tagName === 'metadata')) {
    const key = readString(event.data.key)
    const value = readMetadataValue(event.data.value)
    if (key && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
      metadata[key] = value
    }
  }
  return {
    repository: readString(data.repository),
    revision: readString(data.revision),
    revisionNumber: readNumber(data.revisionNumber),
    parentIds,
    deltas: events
      .filter((event) => event.tagName === 'revisionInfoDelta')
      .map((event) => ({
        path: readString(event.data.path),
        size: readNumber(event.data.size),
        action: readString(event.data.action, 'modify').toLowerCase(),
        modified: readBoolean(event.data.flagModify),
        merged: readBoolean(event.data.flagMerged),
        file: readBoolean(event.data.flagFile)
      }))
      .filter((delta) => delta.path.length > 0),
    metadata
  }
}

function parseRevisionFind(events: LoreEvent[]): string {
  const signature = readString(eventData(events, 'revisionFind')?.signature)
  return ZERO_HASH_PATTERN.test(signature) ? '' : signature
}

function parseRevisionBisect(events: LoreEvent[]): LoreRevisionBisectResult {
  const data = eventData(events, 'revisionBisect') ?? {}
  return {
    startRevisionNumber: readNumber(data.startRevisionNumber),
    targetRevisionNumber: readNumber(data.targetRevisionNumber),
    endRevisionNumber: readNumber(data.endRevisionNumber),
    done: readBoolean(data.done)
  }
}

/** Auth 服务之间的 userId 不保证全局唯一，显示名缓存必须同时包含认证端点。 */
function authIdentityKey(authUrl: string, userId: string): string {
  return `${authUrl}\u0000${userId}`
}

function parseAuthIdentities(events: LoreEvent[]): LoreAuthIdentity[] {
  return events
    .filter((event) => event.tagName === 'authIdentity')
    .map((event) => {
      const userId = readString(event.data.userId)
      const expires = readNumber(event.data.expires)
      return {
        authUrl: readString(event.data.authUrl),
        resource: readString(event.data.resource),
        userId,
        authorizedDomains: readString(event.data.authorizedDomains)
          .split(',')
          .map((domain) => domain.trim())
          .filter(Boolean),
        expiresAt: expires > 0 ? expires : undefined,
        displayName: undefined
      }
    })
    .filter((identity) => identity.authUrl.length > 0 && identity.userId.length > 0)
}

function parseChanges(events: LoreEvent[]): ChangeFile[] {
  return events
    .filter(
      (event) => event.tagName === 'repositoryStatusFile' && readString(event.data.type).toLowerCase() !== 'directory'
    )
    .map((event, index): ChangeFile => {
      const fullPath = readString(event.data.path, `unknown-${index}`)
      const separatorIndex = fullPath.lastIndexOf('/')
      const action = readString(event.data.action).toLowerCase()
      const status: ChangeStatus =
        action === 'add' || action === 'copy'
          ? 'added'
          : action === 'delete'
            ? 'deleted'
            : action === 'move'
              ? 'renamed'
              : 'modified'

      return {
        // 路径在一次仓库快照内唯一，使用它作为稳定 ID，视图切换和刷新后仍能保留选择。
        id: fullPath,
        path: separatorIndex >= 0 ? fullPath.slice(0, separatorIndex) : '.',
        name: separatorIndex >= 0 ? fullPath.slice(separatorIndex + 1) : fullPath,
        status,
        staged: readBoolean(event.data.flagStaged),
        additions: 0,
        deletions: 0,
        binary: !isTextLikeFile(fullPath),
        size: formatBytes(readNumber(event.data.size)),
        previousPath: readString(event.data.fromPath).replaceAll('\\', '/') || undefined,
        conflict: readBoolean(event.data.flagConflict),
        conflictUnresolved: readBoolean(event.data.flagConflictUnresolved)
      }
    })
}

function parseWorkingTreeDiffs(events: LoreEvent[]): WorkingTreeDiff[] {
  return events
    .filter((event) => event.tagName === 'fileDiff')
    .map(
      (event): WorkingTreeDiff => ({
        path: readString(event.data.path),
        patch: readString(event.data.patch),
        action: readString(event.data.action, 'keep').toLowerCase()
      })
    )
    .filter((diff) => diff.path.length > 0)
}

function parseFileHistory(events: LoreEvent[]): FileHistoryEntry[] {
  return events
    .filter((event) => event.tagName === 'fileHistory')
    .map(
      (event): FileHistoryEntry => ({
        path: readString(event.data.path),
        revision: readString(event.data.revision),
        revisionNumber: readNumber(event.data.revisionNumber),
        parent: Array.isArray(event.data.parent)
          ? event.data.parent.filter((value): value is string => typeof value === 'string')
          : [],
        size: readNumber(event.data.size),
        action: readString(event.data.action, 'keep').toLowerCase()
      })
    )
    .filter((entry) => entry.path.length > 0 && entry.revision.length > 0)
}

/**
 * 批量收集 Revision 历史中可能是 userId 的作者 identity。
 *
 * userId 由 Auth 提供方定义，客户端没有稳定正则可以区分它和普通
 * 自由文本。因此沿用上游 CLI 的做法：去重后整批交给 Auth，只消费
 * 服务端实际返回的映射。
 */
function containsIdentityControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x1f || codePoint === 0x7f) return true
  }
  return false
}

function collectRevisionAuthorIdentities(events: LoreEvent[]): string[] {
  const identities = new Set<string>()
  let currentMetadata: Map<string, unknown> | null = null

  /** 只提交该 Revision 最终会显示的 identity，与 `parseRevisions` 保持同一优先级。 */
  const appendCurrentIdentity = () => {
    if (!currentMetadata) return
    const identity = readString(currentMetadata.get('committed-by') ?? currentMetadata.get('created-by')).trim()
    if (identity && identity.length <= 512 && !containsIdentityControlCharacter(identity)) {
      identities.add(identity)
    }
  }

  for (const event of events) {
    if (event.tagName === 'revisionHistoryEntry') {
      appendCurrentIdentity()
      currentMetadata = new Map()
    } else if (event.tagName === 'metadata' && currentMetadata) {
      const key = readString(event.data.key)
      if (key === 'committed-by' || key === 'created-by') {
        currentMetadata.set(key, readMetadataValue(event.data.value))
      }
    }
  }
  appendCurrentIdentity()
  return [...identities]
}

/**
 * 尽力把历史 userId 解析为 Auth 用户名。
 *
 * 这是不可依赖的显示增强：未绑定账户、离线、无权限、旧服务器
 * 或部分 ID 不存在时都返回已成功的子集，调用方继续使用原 identity。
 */
async function resolveRevisionAuthorNames(
  repositoryPath: string,
  events: LoreEvent[],
  repositoryOnline: boolean
): Promise<Map<string, string>> {
  const identities = collectRevisionAuthorIdentities(events)
  if (identities.length === 0) return new Map()

  if (repositoryOnline) {
    try {
      const result = await runOperation('lore_auth_user_info', {
        repositoryPath,
        userIds: identities
      })
      const resolved = new Map<string, string>()
      for (const event of result.events) {
        if (event.tagName !== 'authUserInfo') continue
        const userId = readString(event.data.id).trim()
        const username = readString(event.data.name).trim()
        if (userId && username && username !== userId) {
          resolved.set(userId, username)
        }
      }
      return resolved
    } catch {
      // 在线状态与 Auth 服务可用性并不等价；远端查询失败后继续尝试本地绑定缓存。
    }
  }

  /*
   * 离线时不制造必然失败的远端操作记录；只尝试仓库当前绑定账户的本地脱敏资料。
   * Rust 会把候选严格限制为绑定 userId，避免把当前账户名称套给其他历史作者。
   */
  try {
    const localResult = await runOperation('lore_auth_repository_local_user_info', {
      repositoryPath,
      userIds: identities
    })
    const locallyResolved = new Map<string, string>()
    for (const event of localResult.events) {
      if (event.tagName !== 'authUserInfo') continue
      const userId = readString(event.data.id).trim()
      const username = readString(event.data.name).trim()
      if (userId && username && username !== userId) {
        locallyResolved.set(userId, username)
      }
    }
    return locallyResolved
  } catch {
    return new Map()
  }
}

function parseRevisions(
  events: LoreEvent[],
  repository: Repository,
  branches: Branch[] = [],
  resolvedAuthorNames: ReadonlyMap<string, string> = new Map()
): Revision[] {
  type PendingRevision = {
    entry: Record<string, unknown>
    metadata: Map<string, unknown>
  }
  const pending: PendingRevision[] = []
  let current: PendingRevision | null = null

  // Metadata 事件紧跟对应的 history entry，直到下一个 entry 开始。
  for (const event of events) {
    if (event.tagName === 'revisionHistoryEntry') {
      current = { entry: event.data, metadata: new Map() }
      pending.push(current)
    } else if (event.tagName === 'metadata' && current) {
      current.metadata.set(readString(event.data.key), readMetadataValue(event.data.value))
    }
  }

  return pending.map(({ entry, metadata }, index): Revision => {
    const id = readString(entry.revision, `revision-${index}`)
    const timestampValue = readNumber(metadata.get('timestamp'))
    // 固定 Lore 提交使用毫秒；阈值兼容非常早期可能写入秒值的仓库。
    const timestampMilliseconds =
      timestampValue > 0 && timestampValue < 100_000_000_000 ? timestampValue * 1_000 : timestampValue
    const timestamp = timestampMilliseconds ? new Date(timestampMilliseconds) : null
    /*
     * Revision 作者是提交时固化的历史事实，只能来自该 Revision 自己的元数据。
     * repository.identity 表示“当前仓库下一次提交准备使用的身份”，它可能在历史
     * 形成后被修改，因此绝不能用来回填旧 Revision 的作者。
     */
    const historicalIdentity = readString(
      metadata.get('committed-by') ?? metadata.get('created-by'),
      t('unknownAuthor')
    )
    /*
     * Auth 只会为真实 userId 返回名称；未返回的候选值必须继续使用
     * Revision 中固化的 identity。解析后统一走 `Name <email>` / 纯 email /
     * 自由文本规则，确保 username 携带邮箱时也能获得 Gravatar。
     */
    const displayIdentity = resolvedAuthorNames.get(historicalIdentity) ?? historicalIdentity
    const { author, email: authorEmail } = revisionAuthorFromIdentity(displayIdentity)
    const message = readString(metadata.get('message'), `Revision #${readNumber(entry.revisionNumber)}`)
    const parents = Array.isArray(entry.parent) ? entry.parent : []
    const parentIds = parents.filter(
      (parent): parent is string => typeof parent === 'string' && !ZERO_HASH_PATTERN.test(parent)
    )
    const parentCount = parentIds.length

    /*
     * Branch 是会移动的指针，不是 Revision 的历史归属。只把 `latest` 与当前
     * Revision 精确相等的活动 Branch 附着到这一行；同名的本地/远端 Branch
     * 依靠稳定 ID 与 kind 区分，不能从名称或图谱 lane 反推。
     */
    const branchPointers: RevisionBranchPointer[] = branches
      .filter((branch) => !branch.archived && branch.latest === id)
      .sort((left, right) => {
        if (Boolean(left.current) !== Boolean(right.current)) {
          return left.current ? -1 : 1
        }
        if (Boolean(left.remote) !== Boolean(right.remote)) {
          return left.remote ? 1 : -1
        }
        return left.name.localeCompare(right.name)
      })
      .map((branch) => ({
        id: branch.id,
        name: branch.name,
        kind: branch.remote ? ('remote' as const) : ('local' as const)
      }))

    /*
     * HEAD 表示当前 Instance 的真实 Revision 锚点，不是历史首行，也不是 Branch
     * latest 的别名。历史可以从 Branch tip 开始，而 HEAD 精确停在更早的任意行。
     */
    if (id === repository.revision) {
      branchPointers.push({
        id: 'head',
        name: 'HEAD',
        kind: 'head'
      })
    }

    return {
      id,
      shortId: id.slice(0, 8),
      title: message,
      // `title` 才是用户输入的 Revision message；这里仅显示简短稳定身份，
      // 避免完整哈希被误认为不可编辑的默认消息。
      description: t('status.revisionLabel', {
        number: readNumber(entry.revisionNumber),
        id: id.slice(0, 8)
      }),
      author,
      authorEmail,
      initials: author.slice(0, 1).toLocaleUpperCase(),
      timestamp: timestamp ? formatDateTime(timestamp) : t('unknownTime'),
      relativeTime: timestamp ? formatRelativeTime(timestamp) : t('unknownTime'),
      branchPointers,
      parentCount,
      parentIds,
      filesChanged: 0,
      additions: 0,
      deletions: 0,
      size: t('loadOnDemand')
    }
  })
}

function eventData(events: LoreEvent[], tagName: string): Record<string, unknown> | undefined {
  return events.find((event) => event.tagName === tagName)?.data
}

function parseRepositoryConfigValue(events: LoreEvent[], key: string): string {
  const event = events.find(
    (candidate) => candidate.tagName === 'repositoryConfigGet' && readString(candidate.data.key) === key
  )
  return readString(event?.data.value).trim()
}

/** 从仓库完整远端 URL 提取服务器根地址，供项目切换时刷新服务器面板。 */
function serverUrlFromRepositoryUrl(remoteUrl: string): string {
  const match = remoteUrl.trim().match(/^([a-z][a-z0-9+.-]*:\/\/[^/]+)/i)
  return match?.[1] ?? remoteUrl.trim()
}

/** 清除 Windows 扩展路径前缀，仅改变展示/持久化形式，不改变目录语义。 */
function normalizeDisplayPath(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) {
    return `\\\\${path.slice('\\\\?\\UNC\\'.length)}`
  }
  return path.startsWith('\\\\?\\') ? path.slice(4) : path
}

function readMetadataValue(value: unknown): unknown {
  if (!isRecord(value)) {
    return value
  }
  return value.data
}

function readString(value: unknown, fallback = ''): string {
  if (typeof value === 'string' && value) {
    return value
  }
  if (typeof value === 'number') {
    return String(value)
  }
  return fallback
}

/**
 * 把 Lore Revision 字段收敛为客户端稳定语义。
 *
 * 固定 Lore 版本使用任意长度的全零哈希表示“没有 Revision”；这里统一返回空串，
 * 让调用方沿用既有的可选 Revision 分支，而不必理解上游协议细节。
 */
function readRevisionId(value: unknown): string {
  const revision = readString(value)
  return revision.length > 0 && /^0+$/.test(revision) ? '' : revision
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === 'true'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stablePathId(path: string): string {
  let hash = 2_166_136_261
  for (const character of path.toLocaleLowerCase()) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16_777_619)
  }
  return `repo-${(hash >>> 0).toString(16)}`
}

function colorFromText(text: string): string {
  const id = stablePathId(text)
  /*
   * 仓库之间只通过同一蓝色谱系的明度差进行轻量区分，不能把随机红、黄、绿
   * 误解为仓库状态。状态仍由 Repository.online 和结构化错误单独表达。
   */
  const index = Number.parseInt(id.slice(-2), 16)
  return repositoryAccentFromIndex(index)
}

function formatBytes(bytes: number): string {
  if (!bytes) {
    return '0 B'
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1_024)), units.length - 1)
  return `${(bytes / 1_024 ** unitIndex).toFixed(unitIndex ? 1 : 0)} ${units[unitIndex]}`
}

function formatDateTime(date: Date): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}`
}

function formatRelativeTime(date: Date): string {
  const deltaMinutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60_000))
  if (deltaMinutes < 1) return t('status.justNow')
  if (deltaMinutes < 60) return t('status.minutesAgo', { count: deltaMinutes })
  if (deltaMinutes < 1_440) return t('status.hoursAgo', { count: Math.floor(deltaMinutes / 60) })
  return t('status.daysAgo', { count: Math.floor(deltaMinutes / 1_440) })
}

/**
 * 仅供适配层单元测试使用的纯事件归一化入口。
 *
 * 组件和业务代码不要直接依赖这些函数，应始终调用 `loadRepositorySnapshot`。
 */
export const loreEventParsers = {
  parseRepository,
  parseBranches,
  parseBranchInfo,
  parseBranchLatest,
  parseBranchDiff,
  parseRevisionInfo,
  parseRevisionFind,
  parseRevisionBisect,
  parseAuthIdentities,
  parseChanges,
  parseWorkingTreeDiffs,
  parseFileHistory,
  parseRevisions,
  parseRemoteRepositories,
  parseLayers,
  parseLinks,
  parseRepositoryConfigValue,
  serverUrlFromRepositoryUrl,
  normalizeDisplayPath
}
