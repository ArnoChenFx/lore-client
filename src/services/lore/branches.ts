/** 分支的协作信息、比较、切换、合并、Cherry-pick 与 Revert。 */
import { t } from '../../i18n'
import type {
  Branch,
  LoreBranchDiff,
  LoreBranchDiffChange,
  LoreBranchInfo,
  LoreBranchLatestEntry,
  LoreEvent,
  LoreOperationResult,
  Repository
} from '../../types'
import { runOperation } from './core'
import {
  eventData,
  isRecord,
  readBoolean,
  readKnownLoreLabel,
  readMetadataValue,
  readNumber,
  readRevisionId,
  readString
} from './utils'

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

/** 归档本地 Branch；联网模式下 Lore 会同步归档远端指针。 */
export async function archiveBranch(
  repositoryPath: string,
  branch: string,
  includeLayers = false
): Promise<LoreOperationResult> {
  return runOperation('lore_branch_archive', { repositoryPath, branch, includeLayers })
}

export function parseBranches(
  events: LoreEvent[],
  repository: Repository,
  resolvedCreatorNames: ReadonlyMap<string, string> = new Map()
): Branch[] {
  const branchEntries = events.filter((event) => event.tagName === 'branchListEntry')
  const remoteLatestById = new Map<string, string>()
  for (const event of branchEntries) {
    if (readString(event.data.location).toLowerCase() !== 'remote') continue
    const name = readString(event.data.name, t('untitledBranch'))
    remoteLatestById.set(readString(event.data.id, name), readRevisionId(event.data.latest))
  }
  const remoteListLoaded =
    remoteLatestById.size > 0 ||
    events.some(
      (event) =>
        (event.tagName === 'branchListBegin' || event.tagName === 'branchListEnd') &&
        readString(event.data.location).toLowerCase() === 'remote'
    )
  const remoteEvidence: BranchRemoteEvidence = { listLoaded: remoteListLoaded, latestById: remoteLatestById }

  const branches = branchEntries.map((event): Branch => {
    const remote = readString(event.data.location).toLowerCase() === 'remote'
    const name = readString(event.data.name, t('untitledBranch'))
    const rawId = readString(event.data.id, name)
    const latest = readRevisionId(event.data.latest)
    const current = readBoolean(event.data.isCurrent)
    const creator = readKnownLoreLabel(event.data.creator)
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
      id: `${remote ? 'remote' : 'local'}:${rawId}`,
      name,
      // 新建空仓库的 Branch Latest 同样是全零哨兵，不应成为历史查询锚点。
      latest,
      current,
      remote,
      archived: readBoolean(event.data.archived),
      branchPoints,
      ...branchSyncProjection(remote, current, repository, rawId, latest, remoteEvidence),
      /*
       * Lore 会用 `unknown` / `<unknown>` 表示缺失的创建者。稳定 DTO 保持字段缺失，
       * 由组件在渲染期按当前语言显示“未知创建者”，避免泄露协议哨兵或冻结翻译。
       */
      author: creator ? (resolvedCreatorNames.get(creator) ?? creator) : undefined,
      creatorIdentity: creator || undefined
    }
  })

  // 某些离线状态只返回当前 Branch 而没有列表事件，仍应保留可操作的当前指针。
  if (!branches.some((branch) => branch.current) && repository.branch) {
    branches.unshift({
      id: `local:${repository.branch}`,
      name: repository.branch,
      current: true,
      ...branchSyncProjection(false, true, repository)
    })
  }
  return branches
}

interface BranchRemoteEvidence {
  /** 只有成功取得远端列表后，“没有对应 ID”才足以证明分支是纯本地。 */
  listLoaded: boolean
  /** Lore 对同一逻辑 Branch 的本地与远端条目使用相同原始 ID。 */
  latestById: ReadonlyMap<string, string>
}

/**
 * Branch List 没有分支级 ahead/behind；只有当前 Branch 可以消费 Repository Status。
 * 但本地与远端条目共享稳定原始 ID，因此远端列表成功后可以证明某分支“仅本地”，
 * 或在两侧 Latest 完全一致时证明“已同步”；Latest 不同仍保持未知方向，不猜测拓扑关系。
 */
function branchSyncProjection(
  remote: boolean,
  current: boolean,
  repository: Repository,
  rawId?: string,
  localLatest?: string,
  remoteEvidence?: BranchRemoteEvidence
): Pick<Branch, 'syncState' | 'ahead' | 'behind'> {
  if (remote) return { syncState: 'remote' }
  if (repository.remoteState === 'local') return { syncState: 'local-only' }
  if (repository.remoteState !== 'online') return { syncState: 'unavailable' }
  const hasRemoteBranch = rawId != null && remoteEvidence?.latestById.has(rawId)
  if (remoteEvidence?.listLoaded && !hasRemoteBranch) return { syncState: 'local-only' }
  const remoteLatest = rawId == null ? undefined : remoteEvidence?.latestById.get(rawId)
  if (current && repository.currentBranchSyncState !== 'unknown') {
    return {
      syncState: repository.currentBranchSyncState ?? 'unknown',
      ahead: repository.ahead,
      behind: repository.behind
    }
  }
  if (localLatest && remoteLatest && localLatest === remoteLatest) {
    return { syncState: 'synced', ahead: 0, behind: 0 }
  }
  return {
    syncState: 'unknown',
    ahead: current ? repository.ahead : undefined,
    behind: current ? repository.behind : undefined
  }
}

export function parseBranchInfo(infoEvents: LoreEvent[], protectionEvents: LoreEvent[]): LoreBranchInfo {
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

export function parseBranchLatest(events: LoreEvent[]): LoreBranchLatestEntry[] {
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

export function parseBranchDiff(events: LoreEvent[], source: string, target: string): LoreBranchDiff {
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
