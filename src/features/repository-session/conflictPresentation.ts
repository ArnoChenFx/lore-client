import { t } from '../../i18n'
import type { ConflictAction, ConflictOperationKind } from '../../types'

/** 在回调执行时读取当前语言，避免长生命周期冲突会话冻结为旧语言。 */
export function conflictOperationLabel(kind: ConflictOperationKind): string {
  if (kind === 'merge') return t('conflictMergeOperation')
  if (kind === 'cherryPick') return t('conflictCherryPickOperation')
  if (kind === 'revert') return t('conflictRevertOperation')
  return t('conflictOperationUnknown')
}

/** 冲突动作只保存语义键，操作中心在展示时再根据当前语言翻译。 */
export function conflictActionLabelKey(action: Exclude<ConflictAction, 'abort'>): string {
  if (action === 'resolve') return 'markConflictResolved'
  if (action === 'mine') return 'useCurrentVersion'
  if (action === 'theirs') return 'useIncomingVersion'
  if (action === 'unresolve') return 'markConflictUnresolved'
  return 'restartSelectedConflict'
}
