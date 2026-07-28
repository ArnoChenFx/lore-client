import type {
  Branch,
  LoreAuthIdentity,
  LoreBranchDiff,
  LoreBranchInfo,
  LoreBranchLatestEntry,
  LoreDependencyGraphQuery,
  LoreDependencySelection,
  LoreDiagnosticReport,
  LoreFileLock,
  LoreLayer,
  LoreLayerAddRequest,
  LoreLayerRemoveRequest,
  LoreLink,
  LoreLinkAddRequest,
  LoreLinkUpdateRequest,
  LoreMetadataEntry,
  LoreMetadataScope,
  LoreRepositoryInstance,
  LoreRevisionInfo,
  OperationDetail,
  Repository,
  RepositoryAuthAccountBinding,
  RepositoryView,
  RepositoryViewPreview,
  Revision
} from '../../types'

/** 仓库工具使用稳定语义页签，入口、控制器和展示组件共享同一联合类型。 */
export type RepositoryToolTab =
  | 'configuration'
  | 'view'
  | 'layers'
  | 'links'
  | 'dependencies'
  | 'locks'
  | 'collaboration'
  | 'revision'
  | 'accounts'
  | 'metadata'
  | 'diagnostics'
  | 'maintenance'

/**
 * 仓库工具展示组件的稳定契约。
 *
 * 该类型放在领域目录中，避免 App 和 Dialog 分别维护一份数十项动作签名；控制器负责
 * 生成契约，展示组件只消费 DTO 与回调，不直接读取服务或应用全局状态。
 */
export interface RepositoryToolsDialogProps {
  tab: RepositoryToolTab
  repository: Repository
  branches?: Branch[]
  revisions?: Revision[]
  defaultIdentity: string
  layers: LoreLayer[]
  links: LoreLink[]
  locks?: LoreFileLock[]
  dependencyQuery?: LoreDependencyGraphQuery | null
  loading: boolean
  compositionAvailable: boolean
  lockAvailable?: boolean
  dependencyAvailable?: boolean
  publishAvailable: boolean
  /** 当前已连接远端仓库的真实说明；未连接或详情不可读时为空。 */
  connectedRemoteDescription?: string
  /** 服务器按稳定 Repository ID 返回的权威名称，用于恢复部分成功的发布。 */
  connectedRemoteName?: string
  /** 发布表单可选择的设备级脱敏账户；Token 始终保留在 Lore Token Store。 */
  publishAuthIdentities?: LoreAuthIdentity[]
  repositoryView: RepositoryView | null
  currentRevisionId?: string
  viewBlockedReason?: string
  onTabChange: (tab: RepositoryToolTab) => void
  onRefresh: () => void
  onSaveConfiguration: (identity: string, remoteUrl: string) => void
  onPublish: (
    identity: string,
    serverUrl: string,
    repositoryName: string,
    description: string,
    authUserId?: string
  ) => void
  onPushCurrentBranch: () => void
  onPreviewView: (content: string) => Promise<RepositoryViewPreview>
  onApplyView: (content: string) => Promise<boolean>
  onAddLayer: (request: LoreLayerAddRequest) => Promise<boolean>
  onRemoveLayer: (request: LoreLayerRemoveRequest) => Promise<boolean>
  onAddLink: (request: LoreLinkAddRequest) => Promise<boolean>
  onUpdateLink: (request: LoreLinkUpdateRequest) => Promise<boolean>
  onRemoveLink: (linkPath: string) => Promise<boolean>
  onAcquireLock?: (path: string) => Promise<boolean>
  onReleaseLock?: (path: string) => Promise<boolean>
  onQueryDependencies?: (
    paths: string[],
    options: LoreDependencySelection,
    reverse: boolean
  ) => Promise<LoreDependencyGraphQuery | null>
  onAddDependency?: (sourcePath: string, dependencyPath: string, tags: string[], force: boolean) => Promise<boolean>
  onRemoveDependency?: (sourcePath: string, dependencyPath: string, tags: string[]) => Promise<boolean>
  onDependencySync?: (options: LoreDependencySelection) => Promise<boolean>
  onLoadBranchCollaboration?: (branch: string) => Promise<{ info: LoreBranchInfo; latest: LoreBranchLatestEntry[] }>
  onLoadBranchDiff?: (source: string, target: string, path?: string) => Promise<LoreBranchDiff>
  onSetBranchProtected?: (branch: string, protectedValue: boolean) => Promise<boolean>
  onResetBranchLatest?: (
    branch: string,
    revision: string,
    expectedWorkspaceRevision: string,
    expectedLatest: string,
    skippedEntries: number
  ) => Promise<boolean>
  onLoadRevisionInfo?: (revision: string) => Promise<LoreRevisionInfo>
  onFindRevisionNumber?: (number: number) => Promise<string>
  onFindRevisionMetadata?: (key: string, value?: string) => Promise<string>
  onAmendRevision?: (message: string) => Promise<boolean>
  onBisectRevision?: (start: string, end: string) => Promise<boolean>
  onRestoreRevision?: (message: string) => Promise<boolean>
  onLocateRevision?: (revision: string) => void
  onListAuthIdentities?: () => Promise<LoreAuthIdentity[]>
  /** 外部认证入口完成后递增，使已打开的账户页立即重读 Token Store 的脱敏投影。 */
  authStateVersion?: number
  accountRepositories?: Repository[]
  authAccountBindings?: RepositoryAuthAccountBinding[]
  onSetAuthAccountBinding?: (repository: Repository, identity?: LoreAuthIdentity) => Promise<boolean>
  onLoginAuthInteractive?: (remoteUrl: string) => Promise<boolean>
  onLoginAuthWithToken?: (remoteUrl: string, token: string, tokenType: string, authUrl?: string) => Promise<boolean>
  onLogoutAuthIdentity?: (identity: LoreAuthIdentity) => Promise<boolean>
  onClearAuthIdentities?: () => Promise<boolean>
  onLoadMetadata?: (scope: LoreMetadataScope, target?: string, revision?: string) => Promise<LoreMetadataEntry[]>
  onVerifyPath?: (path: string, heal: boolean) => Promise<LoreDiagnosticReport>
  onVerifyFragment?: (hash: string, context: string, heal: boolean) => Promise<LoreDiagnosticReport>
  onDumpRepository?: (revision: string, path: string, maxDepth: number) => Promise<LoreDiagnosticReport>
  onListInstances?: () => Promise<LoreRepositoryInstance[]>
  onPruneInstances?: () => Promise<boolean>
  onUpdateInstancePath?: () => Promise<boolean>
  onVerify: () => void
  onCollectGarbage: () => void
  onClose: () => void
}

/** App 提供的统一仓库写入入口；控制器不重复实现串行门闩、冲突分类和快照重读。 */
export type RepositoryMutationRunner = (
  labelKey: string,
  task: (repository: Repository) => Promise<unknown>,
  successDetail: string | OperationDetail
) => Promise<boolean>

/** Repository Tools 对 App 和本地更改暴露的窄接口。 */
export interface RepositoryToolsController {
  dialogProps: RepositoryToolsDialogProps | null
  fileLocks: LoreFileLock[]
  fileLockState: 'loading' | 'ready' | 'unavailable'
  open: (tab: RepositoryToolTab) => Promise<void>
  close: () => void
  acquireFileLocks: (paths: string[]) => Promise<boolean>
  releaseFileLocks: (paths: string[]) => Promise<boolean>
}
