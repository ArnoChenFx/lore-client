/**
 * 成功后可由主界面状态立即确认、且通常会高频触发的轻量仓库操作。
 *
 * 这里只控制成功 Toast；操作记录、错误 Toast 和冲突警告仍由统一写操作流程保留。
 */
const QUIET_SUCCESS_OPERATION_KEYS = new Set([
  'stageFiles',
  'unstageFiles',
  'stageAll',
  'unstageAll',
  'checkOutRevision',
  'switchBranch',
  'attachRemoteBranch',
  'acquireCollaborativeLock',
  'releaseCollaborativeLock'
])

/** 判断仓库写操作成功后是否需要额外显示右下角 Toast。 */
export function shouldAnnounceOperationSuccess(operationKey: string): boolean {
  return !QUIET_SUCCESS_OPERATION_KEYS.has(operationKey)
}
