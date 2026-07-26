import { t } from '../../i18n'
import { readErrorMessage } from '../../shared/lib'
import type {
  ChangeFile,
  NavigationView,
  OperationDetail,
  Repository,
  RepositorySnapshot,
  ToastMessage
} from '../../types'
import {
  normalizeOperationDetail,
  operationMessage,
  resolveOperationDetail,
  shouldAnnounceOperationSuccess
} from '../operations'
import type { ActiveOperation } from '../operations'
import { classifyRepositoryMutationOutcome } from './repositoryMutationOutcome'

interface RepositoryMutationLifecycle {
  activeSnapshot: RepositorySnapshot
  labelKey: string
  task: (repository: Repository) => Promise<unknown>
  successDetail: string | OperationDetail
  nextView?: NavigationView
  loadSnapshot: (repositoryPath: string) => Promise<RepositorySnapshot>
  applySnapshot: (snapshot: RepositorySnapshot) => void
  selectView: (view: NavigationView) => void
  focusConflictFile: (file: ChangeFile) => void
  conflictTitle: (snapshot: RepositorySnapshot) => string
  notify: (title: string, detail: string, tone?: ToastMessage['tone']) => void
  beginOperation: (labelKey: string, detail: string | OperationDetail) => ActiveOperation
  finishOperation: (operation: ActiveOperation, succeeded: boolean, detail: string | OperationDetail) => void
}

/**
 * 执行单次仓库写操作并以 Lore 的最终快照收口界面状态。
 *
 * 门闩、busy 文案和“无仓库时打开目录”属于 App 会话入口，不放进这里；成功、
 * 冲突和失败后的快照恢复则是所有仓库写操作共享的不变量，集中后可独立测试。
 */
export async function runRepositoryMutationLifecycle({
  activeSnapshot,
  labelKey,
  task,
  successDetail,
  nextView,
  loadSnapshot,
  applySnapshot,
  selectView,
  focusConflictFile,
  conflictTitle,
  notify,
  beginOperation,
  finishOperation
}: RepositoryMutationLifecycle): Promise<boolean> {
  const label = t(labelKey as never)
  const detail = normalizeOperationDetail(successDetail)
  const detailText = resolveOperationDetail(detail)
  const operation = beginOperation(labelKey, activeSnapshot.repository.name)

  try {
    await task(activeSnapshot.repository)
    const snapshot = await loadSnapshot(activeSnapshot.repository.path)
    applySnapshot(snapshot)
    const outcome = classifyRepositoryMutationOutcome(activeSnapshot, snapshot, nextView)
    if (outcome.nextView) selectView(outcome.nextView)

    if (outcome.kind === 'conflictStarted') {
      /*
       * Lore 会以成功状态码进入持久冲突会话。“命令完成”不等于“合并完成”，因此
       * 必须使用真实冲突警告并聚焦文件，不能继续显示普通成功 Toast。
       */
      const firstConflict = snapshot.changes.find((file) => file.conflict && file.conflictUnresolved)
      const fallbackConflict = firstConflict ?? snapshot.changes.find((file) => file.conflict)
      if (fallbackConflict) focusConflictFile(fallbackConflict)

      const conflictCount =
        snapshot.repository.unresolvedConflictCount ||
        snapshot.changes.filter((file) => file.conflict && file.conflictUnresolved).length ||
        snapshot.repository.conflictCount ||
        snapshot.changes.filter((file) => file.conflict).length
      const conflictDetail = operationMessage('status.conflictFilesNeedResolution', {
        count: conflictCount
      })
      notify(conflictTitle(snapshot), resolveOperationDetail(conflictDetail), outcome.tone)
      finishOperation(operation, true, conflictDetail)
      return true
    }

    if (shouldAnnounceOperationSuccess(labelKey)) {
      notify(t('status.completed', { action: label }), detailText, 'success')
    }
    finishOperation(operation, true, detail)
    return true
  } catch (error) {
    const message = readErrorMessage(error)
    /*
     * 组合写操作可能在后续阶段失败，但前置阶段已经合法改变实例锚点。失败路径也
     * 尽力重读快照；重读失败不能覆盖更有价值的原始写操作错误。
     */
    try {
      applySnapshot(await loadSnapshot(activeSnapshot.repository.path))
    } catch {
      // 下一次显式刷新会再次暴露快照读取失败。
    }
    notify(t('status.failed', { action: label }), message, 'warning')
    finishOperation(operation, false, message)
    return false
  }
}
