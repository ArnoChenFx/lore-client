import type { Branch, Revision } from '../../types'

/**
 * 判断目标 Revision 是否位于某个活动本地 Branch 可检出的第一父链上。
 *
 * Lore Merge 的第二父节点仍属于来源 Branch，不能因为它出现在当前 Branch 的完整
 * DAG 中就把它当成当前 Branch Revision。Branch stack 的首个 Revision 是分支点；
 * Lore 允许来源 Branch 在该点检出，因此遍历包含边界，但不会越过边界冒领更早历史。
 */
function branchContainsRevision(branch: Branch, targetRevision: string, revisionById: Map<string, Revision>): boolean {
  let cursor = branch.latest
  const branchPoint = branch.branchPoints?.[0]?.revision
  const visited = new Set<string>()

  while (cursor && !visited.has(cursor)) {
    if (cursor === targetRevision) {
      return true
    }
    if (cursor === branchPoint) {
      return false
    }
    visited.add(cursor)
    cursor = revisionById.get(cursor)?.parentIds[0]
  }
  return false
}

/**
 * 为 Revision Checkout 选择 Lore Core 接受的目标 Branch。
 *
 * 当前 Branch 若确实包含目标则优先保留；否则选择拥有该第一父链的活动本地 Branch。
 * 历史页受到数量上限截断时可能缺少中间父节点，此时回退当前 Branch，让适配层保留
 * 原有结构化错误，而不是凭名称或图谱 lane 猜测一个并不存在的归属。
 */
export function resolveRevisionCheckoutBranch(
  target: Revision,
  branches: Branch[],
  revisions: Revision[],
  currentBranch: string
): string {
  const revisionById = new Map(revisions.map((revision) => [revision.id, revision] as const))
  const localBranches = branches.filter((branch) => !branch.remote && !branch.archived && branch.latest)
  const current = localBranches.find((branch) => branch.name === currentBranch)

  if (current && branchContainsRevision(current, target.id, revisionById)) {
    return current.name
  }

  return localBranches.find((branch) => branchContainsRevision(branch, target.id, revisionById))?.name ?? currentBranch
}
