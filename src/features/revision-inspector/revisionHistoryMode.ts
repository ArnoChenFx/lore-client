import type {
  Branch,
  Repository,
  Revision,
  RevisionBranchPointer,
  RevisionHistoryLaneMode,
  RevisionHistoryQuery
} from '../../types'

/** 找到当前工作区实际附着的本地 Branch；名称回退只用于兼容缺少 `isCurrent` 的离线列表。 */
function findCurrentLocalBranch(repository: Pick<Repository, 'branch'>, branches: Branch[]): Branch | undefined {
  return (
    branches.find((branch) => !branch.remote && !branch.archived && branch.current) ??
    branches.find((branch) => !branch.remote && !branch.archived && branch.name === repository.branch)
  )
}

/**
 * 把用户的高级历史筛选与 Lane 模式合并为真实 Lore 查询。
 *
 * 平铺模式是“当前 Branch 历史”而不是单纯的绘制样式，因此必须在数据源处
 * 固定当前 Branch 并启用 `onlyBranch`。同时清除可能属于其他 Branch 的显式起点，
 * 避免从拓扑模式遗留的筛选条件把其他工作线重新带入单道结果。
 */
export function revisionHistoryQueryForLaneMode(
  query: RevisionHistoryQuery,
  repository: Pick<Repository, 'branch'>,
  mode: RevisionHistoryLaneMode
): RevisionHistoryQuery {
  if (mode === 'flat') {
    return {
      ...query,
      branch: repository.branch,
      revision: undefined,
      onlyBranch: true
    }
  }

  return {
    ...query,
    // 空选择表示当前 Branch；显式名称确保工作区停在旧 Revision 时仍从 tip 开始。
    branch: query.branch || repository.branch,
    revision: query.revision?.trim() || undefined
  }
}

/**
 * 用显式第一父关系生成当前 Branch 的单道投影。
 *
 * 桌面端的主边界仍是 Lore `onlyBranch` 查询；此处的投影用于浏览器演示，也作为
 * 防御性收敛，确保合并 Revision 的第二父工作线不会因为仍在已加载窗口中而出现。
 */
export function revisionsForLaneMode(
  revisions: Revision[],
  repository: Pick<Repository, 'branch' | 'revision'>,
  branches: Branch[],
  mode: RevisionHistoryLaneMode
): Revision[] {
  if (mode === 'topology' || revisions.length === 0) {
    return revisions
  }

  const revisionsById = new Map(revisions.map((revision) => [revision.id, revision]))
  const currentBranch = findCurrentLocalBranch(repository, branches)
  /*
   * 日期、数量等服务端筛选可能让 Branch tip 不在当前结果中，此时从 Lore 已排序
   * 结果的首行继续第一父遍历；不能因为窗口被截断就错误地渲染空历史。
   */
  let currentRevisionId =
    (currentBranch?.latest && revisionsById.has(currentBranch.latest) ? currentBranch.latest : undefined) ??
    (revisionsById.has(repository.revision) ? repository.revision : undefined) ??
    revisions[0].id
  const visible: Revision[] = []
  const visited = new Set<string>()

  while (currentRevisionId && !visited.has(currentRevisionId)) {
    visited.add(currentRevisionId)
    const revision = revisionsById.get(currentRevisionId)
    if (!revision) break
    visible.push(revision)
    // 平铺模式只沿第一父延续当前工作线；额外父节点属于被合并的其他 Branch。
    currentRevisionId = revision.parentIds[0] ?? ''
  }

  return visible
}

/**
 * 找出当前历史投影中排在精确工作区 HEAD 之前的 Revision。
 *
 * Lore History 与平铺第一父投影都按新到旧排列，因此 HEAD 前方代表 Branch
 * 已经存在、但当前 Instance 尚未到达的较新历史。这里必须消费搜索前的完整
 * Lane 投影，使用户筛选掉 HEAD 行后，剩余 Revision 的相对状态仍保持稳定。
 */
export function revisionIdsAheadOfHead(revisions: Revision[], headRevisionId: string): Set<string> {
  const headIndex = revisions.findIndex((revision) => revision.id === headRevisionId)
  if (headIndex <= 0) return new Set()

  return new Set(revisions.slice(0, headIndex).map((revision) => revision.id))
}

/**
 * 平铺模式只展示当前 Branch 的本地与同名远端指针。
 *
 * 本地/远端类型来自稳定 DTO，名称只用于配对 Lore 的同一 Branch；不根据 Git 风格
 * `origin/` 前缀、颜色或 lane 位置推断对象类型。HEAD 是精确工作区锚点而非其他
 * Branch，因此继续显示；只有其他 Branch 的本地/远端指针会被隐藏。
 */
export function branchPointersForLaneMode(
  pointers: RevisionBranchPointer[],
  repository: Pick<Repository, 'branch'>,
  branches: Branch[],
  mode: RevisionHistoryLaneMode
): RevisionBranchPointer[] {
  if (mode === 'topology') {
    return pointers
  }

  const currentBranch = findCurrentLocalBranch(repository, branches)
  const currentBranchName = currentBranch?.name ?? repository.branch

  return pointers.filter(
    (pointer) =>
      pointer.kind === 'head' ||
      ((pointer.kind === 'local' || pointer.kind === 'remote') && pointer.name === currentBranchName)
  )
}
