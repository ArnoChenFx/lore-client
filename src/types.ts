export type NavigationView = 'history' | 'changes' | 'branches' | 'tags'
export type InspectorTab = 'overview' | 'changes' | 'tree'

/**
 * 跨工作区入口发出的 Revision 定位请求。
 *
 * `sequence` 让同一 Revision 的连续定位仍然产生新事件；仅存 Revision ID 会被
 * React 的相同状态值去重，用户再次点击同一分支时便无法把历史行滚回视口。
 */
export interface RevisionRevealRequest {
  revisionId: string
  sequence: number
}
export type ChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed'
export type ThemePreference = 'system' | 'dark' | 'light'
export type ResolvedTheme = 'dark' | 'light'
/** 当前客户端正式支持的界面语言。 */
export type LanguagePreference = 'zh-CN' | 'en-US'
export type OperationStatus = 'running' | 'succeeded' | 'failed'
export type LoreOperationStreamPhase = 'queued' | 'running' | 'streaming' | 'succeeded' | 'failed' | 'cancelled'
/** Lore 固定版本可持久恢复的冲突操作类型；unknown 只用于异常或未来格式。 */
export type ConflictOperationKind = 'merge' | 'cherryPick' | 'revert' | 'unknown'
/** 文件级冲突动作与仓库级中止动作的稳定 IPC 语义。 */
export type ConflictAction = 'resolve' | 'mine' | 'theirs' | 'unresolve' | 'restart' | 'abort'
/** 远端连接状态；把无远端、网络不可达与认证失败分开，供恢复策略精确决策。 */
export type RepositoryRemoteState = 'local' | 'offline' | 'unauthorized' | 'online'

/**
 * 当前仓库的冲突会话。
 *
 * 类型由 Lore staged Revision 的真实元数据恢复，不依赖 React 会话状态；因此应用
 * 重启、仓库切换或外部 Lore 操作后仍能重新识别。
 */
export interface ConflictSession {
  kind: ConflictOperationKind
  /** 冲突开始时工作区附着的本地 Revision，用作外部 Merge 的 LOCAL。 */
  currentRevision: string
  stagedRevision: string
  incomingRevision?: string
}

export interface Repository {
  id: string
  name: string
  branch: string
  /** 当前 Instance 的真实 Revision 锚点；它可以早于当前 Branch 的 latest。 */
  revision: string
  path: string
  ahead: number
  behind: number
  /**
   * Lore Status 对当前工作区 Branch 的远端比较结论。
   *
   * 该状态只属于当前 Branch，不能复制给其他本地 Branch；旧 Lore 未返回比较标记时
   * 必须保持 `unknown`，不得把缺失字段解释为已经同步。
   */
  currentBranchSyncState?: BranchSyncState
  online: boolean
  /** 当前快照观察到的远端状态；`online` 保留为常用布尔投影。 */
  remoteState: RepositoryRemoteState
  color: string
  /** 仓库配置中的完整远端地址，例如 `lore://host:41337/repository`。 */
  remoteUrl?: string
  /** 从完整远端地址提取的服务器根地址，供服务器目录和后续网络操作复用。 */
  serverUrl?: string
  /** `.lore/config.toml` 中供 Lore 创建新修订时写入作者元数据的提交身份。 */
  identity?: string
  /** 当前状态快照中携带冲突标记的文件数量。 */
  conflictCount: number
  /** 当前仍需要用户处理的冲突文件数量。 */
  unresolvedConflictCount: number
}

/** 分支总览可诚实表达的远端比较状态；不包含任何按名称猜测的跟踪关系。 */
export type BranchSyncState =
  | 'synced'
  | 'ahead'
  | 'behind'
  | 'diverged'
  | 'unknown'
  | 'unavailable'
  | 'local-only'
  | 'remote'

/**
 * `.lore/config.toml` 中允许客户端编辑的稳定投影。
 *
 * Rust 适配层只会读写这两个白名单字段；Store、File 和未来 Lore 新增的配置
 * 不会经由前端 DTO 往返，避免旧客户端保存设置时覆盖未知字段。
 */
export interface RepositoryConfiguration {
  identity?: string
  remoteUrl?: string
}

/** 当前 Instance 的选择性同步规则诊断；code 由界面映射到当前语言。 */
export interface RepositoryViewDiagnostic {
  line: number
  severity: 'warning' | 'error'
  code: 'view_inclusion_starts_with_double_star' | 'view_inclusion_without_exclusion'
}

/** 当前仓库格式对应的 `.lore/view` 或旧 `.urc/view` 稳定投影。 */
export interface RepositoryView {
  path: string
  exists: boolean
  content: string
  valid: boolean
  ruleCount: number
  exclusionCount: number
  inclusionCount: number
  diagnostics: RepositoryViewDiagnostic[]
}

export type RepositoryViewImpactAction = 'materialize' | 'dematerialize'

/** View 预览中最多返回 200 个受影响文件，完整数量始终由汇总字段表达。 */
export interface RepositoryViewImpactFile {
  path: string
  size: number
  action: RepositoryViewImpactAction
}

/** 基于当前 Revision 完整文件树与真实物化状态计算的只读影响预览。 */
export interface RepositoryViewPreview {
  revision: string
  valid: boolean
  ruleCount: number
  exclusionCount: number
  inclusionCount: number
  diagnostics: RepositoryViewDiagnostic[]
  totalFiles: number
  includedFiles: number
  excludedFiles: number
  materializeFiles: number
  dematerializeFiles: number
  unchangedFiles: number
  includedBytes: number
  materializeBytes: number
  dematerializeBytes: number
  impactFiles: RepositoryViewImpactFile[]
}

/** View 文件替换与 Lore Sync 的组合结果。 */
export interface RepositoryViewApplyResult {
  preview: RepositoryViewPreview
  result: LoreOperationResult
}

/** 目录选择后的稳定探测结果；仓库子目录会解析到实际仓库根目录。 */
export interface RepositoryDirectoryProbe {
  kind: 'repository' | 'unmanaged'
  selectedPath: string
  repositoryPath?: string
}

/** 原地初始化返回规范化路径和完整 Lore Create 事件。 */
export interface LoreRepositoryInitializeResult {
  repositoryPath: string
  result: LoreOperationResult
}

export type LoreRepositoryPublishFailureStage = 'remoteCreate' | 'configuration' | 'push'

/** 已有本地仓库发布到远端时三个不可伪造回滚阶段的稳定结果。 */
export interface LoreRepositoryPublishResult {
  repositoryUrl: string
  remoteCreated: boolean
  remotePreexisting: boolean
  existingRemoteName?: string
  requestedRemoteName: string
  configurationUpdated: boolean
  pushed: boolean
  createResult: LoreOperationResult
  pushResult?: LoreOperationResult
  failureStage?: LoreRepositoryPublishFailureStage
  failureCode?: string
  failureMessage?: string
}

export interface Branch {
  id: string
  name: string
  latest?: string
  current?: boolean
  remote?: boolean
  /** Lore 已归档的本地分支元数据；归档项不得混入可检出的活动分支。 */
  archived?: boolean
  /**
   * Lore Branch stack 中按新到旧排列的分支点。
   *
   * 每个分支点记录该 Branch 从哪个 Branch 的哪个 Revision 分出；Revision 检出用
   * 首个分支点限制第一父链归属，不能把 Merge 的第二父链误判为当前 Branch 历史。
   */
  branchPoints?: Array<{
    branch: string
    revision: string
  }>
  /** 只有适配层取得真实证据后才能设置为 `synced`。 */
  syncState?: BranchSyncState
  ahead?: number
  behind?: number
  author?: string
}

/** BranchInfo 与保护元数据合并后的稳定协作详情。 */
export interface LoreBranchInfo {
  id: string
  name: string
  category: string
  latest: string
  latestRemote: string
  parent: string
  branchPoint: string
  creator: string
  created: number
  archived: boolean
  protected: boolean
}

/** 本地 LATEST 指针历史中的一条不可变 Revision。 */
export interface LoreBranchLatestEntry {
  branch: string
  revision: string
}

/** Branch Diff 中可自动合并或普通变化的文件节点。 */
export interface LoreBranchDiffChange {
  path: string
  action: string
  automerged: boolean
}

/** Branch Diff 中来源与目标两侧的冲突节点。 */
export interface LoreBranchDiffConflict {
  path: string
  source: LoreBranchDiffChange
  target: LoreBranchDiffChange
}

export interface LoreBranchDiff {
  source: string
  target: string
  changes: LoreBranchDiffChange[]
  conflicts: LoreBranchDiffConflict[]
}

/** 新分支的明确起点；界面和 Rust IPC 都不得回退到隐式当前 Revision。 */
export interface BranchCreationSource {
  kind: 'workspace' | 'branch' | 'revision'
  branch: string
  revision: string
  remote?: boolean
}

/** 新标签的精确来源；不得从选中项之外重新推断 Revision。 */
export interface TagCreationSource {
  kind: 'workspace' | 'branch' | 'revision'
  branch: string
  revision: string
}

/** 由 Lore Client 写入 Lore 仓库共享元数据的稳定标签。 */
export interface LoreTag {
  id: string
  name: string
  branch: string
  revision: string
  message: string
  createdAt: number
  updatedAt: number
}

export type RevisionBranchPointerKind = 'local' | 'remote' | 'head'

/**
 * 附着到精确 Revision 的 Branch 指针。
 *
 * Branch 名称不携带对象类型；本地与远端 Branch 甚至可以同名，因此必须把
 * `kind` 作为稳定 DTO 的一部分，不能再从 `origin/` 等显示前缀猜测颜色或语义。
 */
export interface RevisionBranchPointer {
  id: string
  name: string
  kind: RevisionBranchPointerKind
}

export interface Revision {
  id: string
  shortId: string
  title: string
  description: string
  author: string
  /** 从提交时 identity 拆出的邮箱；只用于头像哈希，不替代历史作者文字。 */
  authorEmail?: string
  initials: string
  timestamp: string
  relativeTime: string
  /** 当前精确指向该 Revision 的 Branch，以及工作区 HEAD；不表示历史归属。 */
  branchPointers: RevisionBranchPointer[]
  parentCount: number
  /**
   * Lore 历史事件按顺序返回的有效父 Revision。
   * 第一项延续当前历史方向，后续项表达额外父边；图谱 lane 和历史 Diff
   * 都必须消费这份显式拓扑，不能从分支名称或展示字段重新推断。
   */
  parentIds: string[]
  filesChanged: number
  additions: number
  deletions: number
  size: string
}

/** Revision Info 的文件级父子变化。 */
export interface LoreRevisionInfoDelta {
  path: string
  size: number
  action: string
  modified: boolean
  merged: boolean
  file: boolean
}

/** Revision Info 与 Metadata 事件合并后的稳定详情。 */
export interface LoreRevisionInfo {
  repository: string
  revision: string
  revisionNumber: number
  parentIds: string[]
  deltas: LoreRevisionInfoDelta[]
  metadata: Record<string, string | number | boolean>
}

/** Bisect 单步同步结果；目标哈希由写操作后的真实仓库快照提供。 */
export interface LoreRevisionBisectResult {
  startRevisionNumber: number
  targetRevisionNumber: number
  endRevisionNumber: number
  done: boolean
}

/** 文件正文是否适合文本 Diff；`unknown` 表示当前轻量阶段没有足够证据。 */
export type FileContentKind = 'text' | 'binary' | 'unknown'

/** 内容分类所依据的证据，便于区分真实探测、延迟探测和不可用现场。 */
export type FileContentClassificationSource =
  | 'empty'
  | 'bom'
  | 'signature'
  | 'utf8'
  | 'utf16'
  | 'controlBytes'
  | 'invalidEncoding'
  | 'deferred'
  | 'unavailable'
  | 'changedDuringRead'
  | 'loreDiff'

/** Rust 边界与 Lore Diff 共同产出的稳定内容分类。 */
export interface FileContentClassification {
  kind: FileContentKind
  source: FileContentClassificationSource
}

/**
 * 仓库内单个文件的稳定身份。
 *
 * 变更列表与不可变 Revision 文件树都共享这些只读字段；Stage、变更类型和行数统计
 * 不属于文件身份，必须继续由 `ChangeFile` 单独表达。
 */
export interface RepositoryFileReference {
  id: string
  path: string
  name: string
  /**
   * 权威内容分类。旧演示夹具可能暂时缺省，此时兼容层才读取 `binary`。
   * 新的真实后端结果不得再根据扩展名生成该字段。
   */
  contentClassification?: FileContentClassification
  /** @deprecated 仅保留给旧组件与演示夹具；真实结果由 `contentClassification` 投影。 */
  binary?: boolean
  size?: string
}

export interface ChangeFile extends RepositoryFileReference {
  status: ChangeStatus
  staged: boolean
  additions: number
  deletions: number
  /**
   * Move/Copy 的来源路径；只有 Lore 明确返回真实来源时才存在。
   *
   * 外部 Diff 使用它读取旧版本，不能根据目标文件名猜测重命名前路径。
   */
  previousPath?: string
  conflict?: boolean
  conflictUnresolved?: boolean
}

/**
 * 指定 Revision 中的已提交文件。
 *
 * 该 DTO 不携带工作区 Stage 状态或相对父修订的变更类型，避免文件树把“已提交
 * 快照”和“本次 Revision Diff”混为一谈。
 */
export interface RevisionFile extends RepositoryFileReference {
  size: string
  binary: boolean
}

/** Lore `file::diff` 的稳定前端投影；`patch` 保留标准 unified diff 文本。 */
export interface WorkingTreeDiff {
  path: string
  patch: string
  action: string
  /** Lore unified diff marker 给出的当前文件真实内容分类。 */
  contentClassification?: FileContentClassification
}

/** 工作区与历史 Revision Diff 共用的持久化显示参数。 */
export interface DiffPreferences {
  /** Lore unified diff 的上下文行数；0 表示只显示变化行。 */
  contextLines: number
  ignoreWhitespaceEol: boolean
  ignoreWhitespaceInline: boolean
}

/** 外部 Diff 设置页提供的工具预设；`custom` 允许接入任意本地可执行文件。 */
export type ExternalDiffToolKind = 'none' | 'vscode' | 'cursor' | 'beyondCompare' | 'p4merge' | 'meld' | 'custom'

/**
 * 单个外部 Diff 工具配置。
 *
 * `arguments` 的每一项都会作为独立进程参数传给 Rust，不经过 Shell。支持的模板为
 * `{before}`、`{after}`、`{beforeLabel}` 与 `{afterLabel}`。
 */
export interface ExternalDiffToolPreference {
  /** 跨重启稳定的工具标识；同一预设允许存在多个不同参数实例。 */
  id: string
  kind: ExternalDiffToolKind
  name: string
  executable: string
  arguments: string[]
  primary: boolean
}

/** Merge 与 Diff 共享工具来源预设，但使用独立的四路参数模板。 */
export type ExternalMergeToolPreference = ExternalDiffToolPreference

/** Rust 按显式路径或系统 PATH 探测后返回的可启动工具。 */
export interface AvailableExternalTool {
  toolId: string
  resolvedExecutable: string
}

/** 外部 Diff 的一侧来源；工作区文件可直接使用，其他来源由 Rust 物化临时文件。 */
export interface ExternalDiffSide {
  kind: 'empty' | 'workspace' | 'revision'
  path: string
  revision?: string
  label: string
}

/** 启动外部 Diff 的稳定 IPC 请求。 */
export interface ExternalDiffRequest {
  repositoryPath: string
  tool: ExternalDiffToolPreference
  before: ExternalDiffSide
  after: ExternalDiffSide
}

/** 外部工具进程已经成功创建后的最小反馈。 */
export interface ExternalDiffLaunchResult {
  toolName: string
  processId: number
  temporaryFileCount: number
}

/** 启动四路外部 Merge 的稳定 IPC 请求。 */
export interface ExternalMergeRequest {
  repositoryPath: string
  tool: ExternalMergeToolPreference
  path: string
  currentRevision: string
  incomingRevision: string
  labels: {
    base: string
    local: string
    remote: string
    merged: string
  }
}

/** 当前二进制 Diff 的稳定类别；`binary` 只承载未知格式的大小元数据，不会渲染正文。 */
export type BinaryPreviewKind =
  | 'image'
  | 'texture'
  | 'pdf'
  | 'model'
  | 'csv'
  | 'audio'
  | 'archive'
  | 'font'
  | 'asset'
  | 'binary'

/** 归档目录中的只读条目；路径只用于展示，不会回传给提取或写入命令。 */
export interface ArchivePreviewEntry {
  path: string
  kind: 'file' | 'directory'
  size: number
  compressedSize?: number
}

/** 引擎资产的稳定语义字段；`key` 在前端映射为当前语言标签。 */
export interface AssetMetadataFact {
  key: string
  value: string
}

/** Rust 对归档或专有引擎资产生成的有界结构化投影。 */
export type StructuredAssetPreview =
  | {
      type: 'archive'
      format: string
      totalEntries: number
      truncated: boolean
      entries: ArchivePreviewEntry[]
      facts: AssetMetadataFact[]
      warningCodes: string[]
    }
  | {
      type: 'assetMetadata'
      format: string
      facts: AssetMetadataFact[]
      warningCodes: string[]
    }

/**
 * 从工作区文件或不可变 Revision Store 按需读取的单个二进制预览。
 *
 * Rust 边界负责路径、类型和大小校验；Raw IPC 直接返回受控载荷，组件不接触 Lore
 * 内容地址或平台绝对路径，也不在 React 状态中保留体积膨胀约 1/3 的 Base64 字符串。
 * `asset` 的 data 只允许承载已验证并重编码的编辑器 PNG 缩略图，不会传输原始专有资产。
 */
export interface BinaryFilePreview {
  path: string
  kind: BinaryPreviewKind
  mimeType: string
  data: Uint8Array
  size: number
  /** 普通超限或格式不支持时只返回大小元数据；支持有界缩略图的大型工作区资产仍可为 `available`。 */
  contentState: 'available' | 'tooLarge' | 'unsupported' | 'metadataOnly'
  /** 只有 KTX2、归档和引擎资产携带；普通媒体继续使用受控原始载荷。 */
  structuredPreview?: StructuredAssetPreview | null
}

/** Diff 面板的二进制前后版本；新增与删除文件只会存在其中一侧。 */
export interface BinaryDiffPreview {
  before?: BinaryFilePreview
  after?: BinaryFilePreview
}

/** 文件历史事件只保存 Lore 能稳定提供的字段，展示层再关联 Revision 元数据。 */
export interface FileHistoryEntry {
  path: string
  revision: string
  revisionNumber: number
  parent: string[]
  size: number
  action: string
}

export interface ToastMessage {
  id: number
  title: string
  detail: string
  tone: 'success' | 'info' | 'warning'
}

export type ApplicationMode = 'tauri' | 'browser-demo'

/** Tauri 按平台解析的固定应用日志目录及有界轮转策略。 */
export interface ApplicationLogInfo {
  directoryPath: string
  activeFilePath: string
  maxFileSizeBytes: number
  retainedFileCount: number
}

export interface LoreRuntimeInfo {
  application: string
  available: boolean
  integrationMode: string
  loreCoreStatus: string
  libraryVersion: string
  sourceRevision: string
}

/** Lore 凭据存储中脱敏后的身份或资源授权条目。 */
export interface LoreAuthIdentity {
  authUrl: string
  resource: string
  userId: string
  authorizedDomains: string[]
  expiresAt?: number
  /** 登录完成事件可能提供显示名；账户列表本身不解密 Token。 */
  displayName?: string
}

/**
 * Lore Core 的事件枚举在 Rust 端使用 `tagName` 和 `data` 序列化。
 *
 * 这里刻意保留未知数据，而不是为 nightly 版本复制完整类型树。组件只消费
 * `RepositorySnapshot`，上游事件变化只会影响 `services/lore.ts` 中的归一化逻辑。
 */
export interface LoreEvent {
  tagName: string
  data: Record<string, unknown>
}

export interface LoreOperationResult {
  operation: string
  status: number
  durationMs: number
  events: LoreEvent[]
}

/** Rust 适配层实时发出的单个操作生命周期或 Lore 事件。 */
export interface LoreOperationStreamEvent {
  operationId: string
  operation: string
  phase: LoreOperationStreamPhase
  event?: LoreEvent
  status?: number
  durationMs?: number
  /** 固定 Lore 当前没有通用长操作取消 API；只有通知订阅可真实取消。 */
  cancellable: boolean
}

/** 操作中心中的流式聚合记录，保留最近阶段和轻量指标，不复制大型事件载荷。 */
export interface LoreOperationStreamRecord {
  operationId: string
  operation: string
  phase: LoreOperationStreamPhase
  startedAt: number
  durationMs?: number
  eventCount: number
  lastEventTag?: string
  current?: number
  total?: number
  bytes?: number
  cancellable: boolean
}

export interface LoreRepositoryNotification {
  repositoryPath: string
  event: LoreEvent
}

/** Clone 命令额外返回 Rust 端规范化后的目标目录。 */
export interface LoreCloneResult {
  destinationPath: string
  result: LoreOperationResult
}

/** 初始化本地仓库时对 Shared Store 的显式选择；空路径由 Lore 解析默认 Store。 */
export interface LoreRepositoryInitializeOptions {
  useSharedStore: boolean
  sharedStorePath?: string
}

/** Clone 中对 Shared Store 的显式选择；空路径表示使用对应远端的默认 Store。 */
export interface LoreCloneOptions {
  useSharedStore: boolean
  sharedStorePath?: string
  /** 留空时由 Lore 解析默认分支的最新 Revision；也可以传 Branch 名称。 */
  revision?: string
  /** 只创建本地仓库状态与 Revision Tree，不物化工作区文件。 */
  bare?: boolean
  /** 使用 Lore 的 split-write 文件系统执行虚拟克隆。 */
  virtually?: boolean
  /**
   * 让 Lore 直接写入目标文件，而不是先写入临时文件再移动到目标位置。
   * 该选项会改变 Clone 物化阶段的落盘原子替换策略。
   */
  directFileWrite?: boolean
  /** Clone 时组合的远端 Layer；匹配键只在明确提供 Layer 时生效。 */
  layer?: LoreCloneLayerOptions
  dependency?: LoreDependencySelection
}

/** Clone 初始 Layer 的稳定前端参数，不暴露上游内部 Module/Path 类型。 */
export interface LoreCloneLayerOptions {
  repository: string
  metadataKey?: string
}

/** Clone 与 Sync 共用的依赖闭包选择，空根文件集合表示完整物化。 */
export interface LoreDependencySelection {
  rootFiles: string[]
  tags: string[]
  recursive: boolean
  /** 0 表示不限制深度。 */
  depthLimit: number
}

/** 一条依赖边；深度由 Lore 对当前查询的遍历结果计算。 */
export interface LoreDependencyEntry {
  path: string
  tags: string[]
  depth: number
}

/** 某个查询根文件对应的依赖或反向依赖集合。 */
export interface LoreDependencyGroup {
  path: string
  entries: LoreDependencyEntry[]
}

export interface LoreDependencyQuery {
  groups: LoreDependencyGroup[]
  reverse: boolean
  recursive: boolean
  depthLimit: number
}

/** 依赖图中的文件节点；distance 是沿当前查询方向从最近根文件计算的最短距离。 */
export interface LoreDependencyGraphNode {
  path: string
  distance: number
  root: boolean
}

/**
 * 一条精确的文件依赖边。
 *
 * 方向始终保持 Lore 的 `source → dependency` 语义；反向查询只改变遍历方向，
 * 不反转边，避免界面把“依赖者”误写成“被依赖项”。
 */
export interface LoreDependencyGraphEdge {
  sourcePath: string
  dependencyPath: string
  tags: string[]
}

/**
 * 由分层直连查询重建的稳定依赖图。
 *
 * `groups` 保留每批 Lore List 的原始直连分组，供诊断和协议回归使用；界面只消费
 * 去重后的 nodes/edges。达到 nodeLimit 时 truncated 为 true，不把有界结果伪装
 * 成完整仓库闭包。
 */
export interface LoreDependencyGraphQuery extends LoreDependencyQuery {
  revision: string
  nodes: LoreDependencyGraphNode[]
  edges: LoreDependencyGraphEdge[]
  truncated: boolean
  nodeLimit: number
}

/** 设备级 Shared Store 条目，不暴露 Store Handle 或内容地址。 */
export interface LoreSharedStoreEntry {
  remoteUrl: string
  /** Lore 返回的实际 `shared_store` 数据目录。 */
  path: string
  /** Clone 显式参数所需的 Store 容器目录。 */
  containerPath: string
  exists: boolean
  sizeBytes: number
  fileCount: number
  scanError?: string
}

/** 设备全局 Shared Store 配置与可验证的当前占用。 */
export interface LoreSharedStoreInfo {
  useAutomatically: boolean
  stores: LoreSharedStoreEntry[]
  totalSizeBytes: number
  /** 固定 Lore 版本无法重建未去重基线，因此当前始终为 false。 */
  exactSavingsAvailable: boolean
}

/**
 * 固定 Lore 文件锁的稳定只读投影。
 *
 * `owner` 是服务端返回的 Owner ID；账户能力可在展示时解析名称，但不得改写锁
 * 身份。该锁仅是协作提示，不代表强制独占。
 */
export interface LoreFileLock {
  path: string
  branch: string
  owner: string
  lockedAt: number
}

export interface LoreCommandError {
  code: string
  message: string
}

export interface RepositorySnapshot {
  repository: Repository
  branches: Branch[]
  revisions: Revision[]
  changes: ChangeFile[]
  tags: LoreTag[]
  conflictSession: ConflictSession | null
  loadedAt: string
}

/** 服务器目录中的只读仓库条目。 */
export interface RemoteRepository {
  id: string
  name: string
  /** Repository Info 在 Clone 前按需读取的远端描述与权限身份信息。 */
  remoteUrl?: string
  description?: string
  defaultBranch?: string
  defaultBranchId?: string
  creator?: string
  created?: number
  /** 固定 Lore 版本尚不返回这两个字段；保留可选位以兼容后续协议。 */
  permissions?: string
  targetRevision?: string
}

export type LoreMetadataScope = 'repository' | 'branch' | 'revision' | 'file'

/** Lore 元数据事件的只读稳定投影；二进制值只显示摘要，不向组件传输原始字节。 */
export interface LoreMetadataEntry {
  key: string
  type: 'address' | 'boolean' | 'binary' | 'context' | 'hash' | 'numeric' | 'string' | 'unknown'
  value: string
}

/** Lore 记录的一个本地仓库 Instance。 */
export interface LoreRepositoryInstance {
  id: string
  path: string
  branchName: string
  branchId: string
  revision: string
  stale: boolean
}

/** 高级诊断页显示的单条结构化事件摘要。 */
export interface LoreDiagnosticFinding {
  kind: string
  summary: string
  detail: string
  error: boolean
}

export interface LoreDiagnosticReport {
  operation: string
  durationMs: number
  findings: LoreDiagnosticFinding[]
}

/** Revision History 的稳定查询条件，不暴露 Lore Rust 参数类型。 */
export interface RevisionHistoryQuery {
  revision?: string
  branch?: string
  beforeDate?: number
  onlyBranch: boolean
  limit: number
}

export interface LoreLayer {
  id: string
  targetPath: string
  sourceRepository: string
  sourcePath: string
  metadata: string
  revision: string
  /** 该 Layer 内由 Lore 专用事件报告的已暂存文件数。 */
  stagedFileCount: number
}

/** 添加实例本地 Layer 所需的稳定输入，不暴露 Lore Rust Args。 */
export interface LoreLayerAddRequest {
  targetPath: string
  sourceRepository: string
  sourcePath: string
  metadata?: string
}

/** 移除实例本地 Layer；purge 会额外删除挂载目录中的未跟踪内容。 */
export interface LoreLayerRemoveRequest {
  targetPath: string
  sourceRepository: string
  purge: boolean
}

export interface LoreLink {
  id: string
  linkPath: string
  repository: string
  sourcePath: string
  branchName: string
  revision: string
  flags: number
  disableAutoFollow: boolean
  /** Link 子仓库中由 Lore 专用事件报告的已暂存文件数。 */
  stagedFileCount: number
}

/** 添加随父 Revision 版本化的 Link 所需的稳定输入。 */
export interface LoreLinkAddRequest {
  repositoryUrl: string
  linkPath: string
  sourcePath: string
  pin?: string
  disableBranching: boolean
}

/** 固定 Lore 版本的 Link Update 只支持改变 Pin。 */
export interface LoreLinkUpdateRequest {
  linkPath: string
  pin?: string
}

export interface OperationRecord {
  id: number
  /** 操作名称语义键；面板渲染时再翻译，避免语言切换后仍显示旧文案。 */
  labelKey: string
  /** 详情可为纯文本（路径/错误）或语义键（可随语言重译）。 */
  detail: OperationDetail
  status: OperationStatus
  /** 开始时间戳（毫秒）；展示时按当前界面语言格式化。 */
  startedAt: number
  durationMs?: number
}

/** 操作详情：纯文本与可重译文案分开，禁止把已翻译字符串长期存进会话状态。 */
export type OperationDetail =
  | { kind: 'text'; text: string }
  | { kind: 'i18n'; key: string; values?: Record<string, unknown> }

export interface WorkspaceLayout {
  sidebarWidth: number
  inspectorWidth: number
}

/**
 * 本地仓库选择的 Lore 认证账户。
 *
 * 这里只保存 Token Store 的脱敏索引；原始 JWT 始终留在 Rust/Lore 凭据存储中。
 */
export interface RepositoryAuthAccountBinding {
  repositoryPath: string
  authUrl: string
  userId: string
}

/** Revision History 左侧轨道的持久化视觉投影。 */
export type RevisionHistoryLaneMode = 'topology' | 'flat'

/** 工作区标题允许持久化的受控图标标识；具体 SVG 只在 React 渲染边界映射。 */
export type RepositoryIconId =
  | 'boxes'
  | 'folder-git'
  | 'code'
  | 'gamepad'
  | 'globe'
  | 'database'
  | 'package'
  | 'book'
  | 'palette'
  | 'image'
  | 'music'
  | 'film'
  | 'flask'
  | 'cpu'
  | 'terminal'
  | 'rocket'

/**
 * 单个本地仓库 Tab 的展示覆盖。
 *
 * 路径是本地会话身份；名称、颜色和图标只影响客户端展示，不会改写 Lore 仓库配置、
 * 目录名或远端名称。所有覆盖字段都可选，便于用户分别恢复默认值。
 */
export interface RepositoryTabCustomization {
  repositoryPath: string
  name?: string
  color?: string
  icon?: RepositoryIconId
}

/**
 * 桌面客户端写入应用配置目录的单一偏好文件。
 *
 * 这里集中定义所有跨重启状态，组件不得再各自写浏览器 `localStorage`。
 */
export interface ClientPreferences {
  version: number
  theme: ThemePreference
  /** 界面语言使用稳定 BCP 47 标签，避免将来扩展语言时迁移显示名称。 */
  language: LanguagePreference
  /** 是否在正式桌面版启动完成后自动检查应用更新；手动检查始终保持可用。 */
  automaticallyCheckForUpdates: boolean
  /**
   * 仓库没有配置 `identity` 时用于单次提交的客户端默认身份。
   *
   * 空字符串表示未配置；该值只保存在客户端偏好文件，不会隐式写入仓库。
   */
  defaultIdentity: string
  workspaceLayout: WorkspaceLayout
  inspectorTab: InspectorTab
  localChangesView: 'flat' | 'tree'
  localChangesStageSplit: number
  /** 本地更改工作区最右侧 Diff 面板是否显示。 */
  localChangesDiffVisible: boolean
  revisionChangesView: 'flat' | 'tree'
  revisionChangesBrowserWidth: number
  /** Revision“变更”页签内右侧 Diff 面板是否显示。 */
  revisionChangesDiffVisible: boolean
  /** 工作区与 Revision 是否读取并显示可预览的二进制 Diff 内容。 */
  binaryDiffVisible: boolean
  /** 单个二进制文件允许读取并传入内嵌预览的最大原始体积，单位为 MiB。 */
  binaryPreviewLimitMib: number
  /** Revision History 使用完整多道父子拓扑，或仅含当前 Branch 的单道投影。 */
  revisionHistoryLaneMode: RevisionHistoryLaneMode
  diff: DiffPreferences
  /** 有序外部工具注册表；primary 只影响菜单排序，不绕过可执行文件探测。 */
  externalDiffTools: ExternalDiffToolPreference[]
  externalMergeTools: ExternalMergeToolPreference[]
  /** 按规范化本地路径保存的认证账户覆盖；没有条目表示由 Lore 自动选择。 */
  authAccountBindings: RepositoryAuthAccountBinding[]
  /** 按规范化本地路径保存的项目名称、Tab 颜色和工作区图标覆盖。 */
  repositoryTabCustomizations: RepositoryTabCustomization[]
  repositoryPaths: string[]
  activeRepositoryPath: string | null
}
