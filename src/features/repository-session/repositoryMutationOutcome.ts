import type { NavigationView, RepositorySnapshot } from '../../types'

export interface RepositoryMutationOutcome {
  kind: 'completed' | 'conflictStarted'
  tone: 'success' | 'warning'
  nextView?: NavigationView
}

/** 判断快照是否包含 Lore 已持久化的冲突状态。 */
function hasConflict(snapshot: RepositorySnapshot): boolean {
  return Boolean(
    snapshot.conflictSession ||
    snapshot.repository.conflictCount > 0 ||
    snapshot.repository.unresolvedConflictCount > 0 ||
    snapshot.changes.some((file) => file.conflict)
  )
}

/**
 * 把写操作前后的真实快照归纳成用户可见结果。
 *
 * Lore 的 Merge、Cherry-pick 和 Revert 可以用成功状态码进入“等待解决冲突”
 * 状态，因此不能只依赖命令是否抛错。只有本次写操作新引入冲突时才改成警告并
 * 跳转；冲突面板内部的 Resolve/Mine 等动作不会反复触发“新冲突”提示。
 */
export function classifyRepositoryMutationOutcome(
  previousSnapshot: RepositorySnapshot,
  nextSnapshot: RepositorySnapshot,
  requestedView?: NavigationView
): RepositoryMutationOutcome {
  if (!hasConflict(previousSnapshot) && hasConflict(nextSnapshot)) {
    return {
      kind: 'conflictStarted',
      tone: 'warning',
      nextView: 'changes'
    }
  }

  return {
    kind: 'completed',
    tone: 'success',
    nextView: requestedView
  }
}
