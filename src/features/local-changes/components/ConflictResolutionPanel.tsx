import { AlertTriangle, Check, RefreshCw, RotateCcw, ShieldX, Undo2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { ChangeFile, ConflictAction, ConflictSession } from '../../../types'

interface ConflictResolutionPanelProps {
  session: ConflictSession | null
  conflictFiles: ChangeFile[]
  selectedConflictFiles: ChangeFile[]
  busy: boolean
  onAction: (action: Exclude<ConflictAction, 'abort'>, files: ChangeFile[]) => void
  onAbort: () => void
}

/**
 * 把持久冲突会话投影为稳定多语言标签。
 *
 * 返回键而非模块加载期翻译结果，语言切换后面板会立即更新；unknown 只用于
 * 损坏或未来 Lore 格式，并且对应面板不会开放任何写动作。
 */
function operationLabelKey(kind: ConflictSession['kind'] | 'unknown') {
  if (kind === 'merge') return 'conflictMergeOperation'
  if (kind === 'cherryPick') return 'conflictCherryPickOperation'
  if (kind === 'revert') return 'conflictRevertOperation'
  return 'conflictOperationUnknown'
}

/**
 * 本地更改工作区中的冲突控制面板。
 *
 * 文件级动作严格作用于当前明确选中的冲突文件：未解决文件可以标记完成或选择
 * 任一版本，已解决文件可以重新标记；“重新生成”会把选中冲突恢复为 Lore 初始
 * 冲突内容。Abort 独立放在危险操作区，避免与文件级动作混淆。
 */
export function ConflictResolutionPanel({
  session,
  conflictFiles,
  selectedConflictFiles,
  busy,
  onAction,
  onAbort
}: ConflictResolutionPanelProps) {
  const { t } = useTranslation()
  if (conflictFiles.length === 0 && !session) return null

  const kind = session?.kind ?? 'unknown'
  const operation = t(operationLabelKey(kind))
  const unresolvedFiles = conflictFiles.filter((file) => file.conflictUnresolved)
  const selectedUnresolved = selectedConflictFiles.filter((file) => file.conflictUnresolved)
  const selectedResolved = selectedConflictFiles.filter((file) => !file.conflictUnresolved)
  const recognized = Boolean(session && session.kind !== 'unknown')
  const readyToCommit = recognized && conflictFiles.length > 0 && unresolvedFiles.length === 0
  const fileActionDisabled = busy || !recognized

  return (
    <section className={`conflict-resolution ${readyToCommit ? 'is-ready' : ''}`} aria-label={t('conflictResolution')}>
      <div className="conflict-resolution__summary">
        <span className="conflict-resolution__icon" aria-hidden="true">
          {readyToCommit ? <Check size={15} /> : <AlertTriangle size={15} />}
        </span>
        <span>
          <strong>{readyToCommit ? t('conflictsResolvedReadyToCreateRevision') : t('conflictResolution')}</strong>
          <small>
            {readyToCommit
              ? t('createRevisionToFinishConflictOperation')
              : t('status.conflictOperationSummary', {
                  operation,
                  unresolved: unresolvedFiles.length,
                  total: conflictFiles.length
                })}
          </small>
        </span>
        <em>
          {selectedConflictFiles.length > 0
            ? t('status.selectedConflictFiles', { count: selectedConflictFiles.length })
            : t('selectConflictFilesToContinue')}
        </em>
      </div>

      {!recognized && (
        <p className="conflict-resolution__warning">
          <ShieldX size={13} />
          {t('conflictOperationCouldNotBeIdentified')}
        </p>
      )}

      <div className="conflict-resolution__actions">
        <div role="group" aria-label={t('conflictResolution')}>
          <button
            type="button"
            disabled={fileActionDisabled || selectedUnresolved.length === 0}
            onClick={() => onAction('resolve', selectedUnresolved)}
          >
            <Check size={13} />
            {t('markConflictResolved')}
          </button>
          <button
            type="button"
            disabled={fileActionDisabled || selectedUnresolved.length === 0}
            onClick={() => onAction('mine', selectedUnresolved)}
          >
            <Undo2 size={13} />
            {t('useCurrentVersion')}
          </button>
          <button
            type="button"
            disabled={fileActionDisabled || selectedUnresolved.length === 0}
            onClick={() => onAction('theirs', selectedUnresolved)}
          >
            <RefreshCw size={13} />
            {t('useIncomingVersion')}
          </button>
          <button
            type="button"
            disabled={fileActionDisabled || selectedResolved.length === 0}
            onClick={() => onAction('unresolve', selectedResolved)}
          >
            <RotateCcw size={13} />
            {t('markConflictUnresolved')}
          </button>
          <button
            type="button"
            disabled={fileActionDisabled || selectedConflictFiles.length === 0}
            onClick={() => onAction('restart', selectedConflictFiles)}
          >
            <RefreshCw size={13} />
            {t('restartSelectedConflict')}
          </button>
        </div>
        <button type="button" className="conflict-resolution__abort" disabled={busy || !recognized} onClick={onAbort}>
          <ShieldX size={13} />
          {t('abortConflictOperation')}
        </button>
      </div>
    </section>
  )
}
