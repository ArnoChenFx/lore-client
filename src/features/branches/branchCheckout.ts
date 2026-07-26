import type { Branch, Repository } from '../../types'

/**
 * 判断 Branch 检出是否真的无需操作。
 *
 * `branch.current` 只表示当前 Instance 属于哪个 Branch，不能证明工作区已经位于
 * Branch latest；检出旧 Revision 后两者会刻意分离。只有 Branch 身份匹配且精确
 * Revision 也匹配时，界面才能安全跳过原生 Switch。
 */
export function isBranchAlreadyAtWorkspaceRevision(
  branch: Pick<Branch, 'current' | 'latest' | 'name'>,
  repository: Pick<Repository, 'branch' | 'revision'>
): boolean {
  const isWorkspaceBranch = Boolean(branch.current) || branch.name === repository.branch
  return isWorkspaceBranch && Boolean(branch.latest) && branch.latest === repository.revision
}
