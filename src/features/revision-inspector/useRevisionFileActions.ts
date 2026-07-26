import { useCallback } from 'react'

import { confirmLocalized, t } from '../../i18n'
import { resetFilesToRevision, revealWorkspaceFile } from '../../services/lore'
import { readErrorMessage } from '../../shared/lib'
import type { ApplicationMode, RepositoryFileReference, RepositorySnapshot } from '../../types'
import { operationMessage } from '../operations'
import type { AppNotify, RunRepositoryMutation } from '../repository-session'
import { getChangeFileRelativePath } from './components/RevisionFileContextMenu'

interface UseRevisionFileActionsOptions {
  applicationMode: ApplicationMode
  activeSnapshot?: RepositorySnapshot
  runRepositoryMutation: RunRepositoryMutation
  notify: AppNotify
}

/**
 * 管理 Revision 文件的系统定位与历史恢复动作。
 *
 * 两个动作都围绕精确仓库相对路径工作；恢复操作继续经过统一仓库写队列，并在真正
 * 覆盖工作区前展示目标 Revision 与影响范围。
 */
export function useRevisionFileActions({
  applicationMode,
  activeSnapshot,
  runRepositoryMutation,
  notify
}: UseRevisionFileActionsOptions) {
  const revealCurrentFile = useCallback(
    async (file: RepositoryFileReference) => {
      if (!activeSnapshot) return
      const relativePath = getChangeFileRelativePath(file)
      if (applicationMode !== 'tauri') {
        notify(t('browserDemoMode'), t('status.demoWouldRevealInExplorer', { path: relativePath }), 'info')
        return
      }

      try {
        await revealWorkspaceFile(activeSnapshot.repository.path, relativePath)
      } catch (error) {
        notify(t('unableToLocateFile'), readErrorMessage(error), 'warning')
      }
    },
    [activeSnapshot, applicationMode, notify]
  )

  const resetRevisionFile = useCallback(
    async (files: RepositoryFileReference[], targetRevision: string, targetLabel: string) => {
      const relativePaths = files.map(getChangeFileRelativePath)
      const subject =
        files.length > 1
          ? t('status.fileCount', { count: files.length })
          : t('status.quotedName', { name: relativePaths[0] ?? '—' })
      if (applicationMode !== 'tauri') {
        notify(t('browserDemoMode'), t('status.demoWouldRestoreTo', { subject, target: targetLabel }), 'warning')
        return
      }

      const confirmed = confirmLocalized(
        [
          t('confirm.restoreTo', { subject, target: targetLabel }),
          '',
          t('confirm.restoreOverwrite', {
            subject: files.length > 1 ? t('subject.theseFiles') : t('subject.thisFile')
          })
        ].join('\n')
      )
      if (!confirmed) return

      await runRepositoryMutation(
        'restoreRevisionFiles',
        (repository) => resetFilesToRevision(repository.path, relativePaths, targetRevision),
        operationMessage('status.restoredTo', { subject, target: targetLabel })
      )
    },
    [applicationMode, notify, runRepositoryMutation]
  )

  return {
    revealCurrentFile,
    resetRevisionFile
  }
}
