import { useCallback, useEffect, useRef, useState } from 'react'

import { setEveryDemoFileStaged } from '../../demo'
import { confirmLocalized, t } from '../../i18n'
import {
  commitRevision,
  discardWorkspaceFiles,
  ignoreWorkspacePaths,
  loadFileHistory,
  loadWorkingTreeDiff,
  openExternalDiff,
  openExternalMerge,
  openWorkspaceFile,
  runConflictAction,
  savePatchFile,
  stagePaths,
  unstagePaths
} from '../../services/lore'
import {
  changeDirectoryPathFromObjectId,
  changeFileObjectId,
  changeFilePath,
  collectChangeObjectIds,
  combineUnifiedPatches,
  createDemoWorkingTreeDiff,
  createExternalMergeRequest,
  createRevisionExternalDiffRequest,
  createWorkspaceExternalDiffRequest,
  readErrorMessage
} from '../../shared/lib'
import type {
  ApplicationMode,
  ChangeFile,
  ConflictAction,
  DiffPreferences,
  ExternalDiffToolPreference,
  FileHistoryEntry,
  NavigationView,
  Repository,
  RepositoryFileReference,
  RepositorySnapshot,
  Revision
} from '../../types'
import { operationMessage } from '../operations'
import {
  conflictActionLabelKey,
  conflictOperationLabel,
  type AppNotify,
  type RunRepositoryMutation
} from '../repository-session'

interface ChangeSelection {
  selectedIds: string[]
  primaryId: string
}

/**
 * 在仓库快照刷新后修复文件选区。
 *
 * 只保留仍存在的对象 ID；全部失效时选择首个未暂存文本文件，并确保主对象始终属于
 * 当前可见集合。该函数不修改输入，便于独立验证仓库切换和刷新边界。
 */
export function reconcileChangeSelection(
  files: ChangeFile[],
  selectedIds: string[],
  primaryId: string
): ChangeSelection {
  const available = new Set(collectChangeObjectIds(files))
  const fallback =
    files.find((file) => !file.staged && !file.binary) ?? files.find((file) => !file.staged) ?? files[0] ?? null
  const fallbackId = fallback ? changeFileObjectId(fallback.id) : ''
  const retained = selectedIds.filter((id) => available.has(id))
  const nextSelectedIds = retained.length > 0 ? retained : fallbackId ? [fallbackId] : []
  const nextPrimaryId = available.has(primaryId) ? primaryId : (nextSelectedIds[0] ?? '')
  return { selectedIds: nextSelectedIds, primaryId: nextPrimaryId }
}

/** 管理本地更改对象选区，并在仓库快照切换后保留仍然有效的对象。 */
export function useLocalChangeSelection(files?: ChangeFile[]) {
  const initialSelection = reconcileChangeSelection(files ?? [], [], '')
  const [selectedChangeIds, setSelectedChangeIds] = useState<string[]>(initialSelection.selectedIds)
  const [primaryChangeId, setPrimaryChangeId] = useState(initialSelection.primaryId)
  const selectedChangeIdsRef = useRef(selectedChangeIds)
  const selectedChange = files?.find((file) => changeFileObjectId(file.id) === primaryChangeId) ?? null
  const selectedChangeFolder = changeDirectoryPathFromObjectId(primaryChangeId)

  useEffect(() => {
    selectedChangeIdsRef.current = selectedChangeIds
  }, [selectedChangeIds])

  useEffect(() => {
    const currentFiles = files ?? []
    setSelectedChangeIds((current) => {
      const next = reconcileChangeSelection(currentFiles, current, primaryChangeId).selectedIds
      return current.length === next.length && current.every((id, index) => id === next[index]) ? current : next
    })
    setPrimaryChangeId(
      (current) => reconcileChangeSelection(currentFiles, selectedChangeIdsRef.current, current).primaryId
    )
  }, [files, primaryChangeId])

  const selectChangeFiles = useCallback((selectedIds: string[], primaryId: string | null) => {
    setSelectedChangeIds(selectedIds)
    setPrimaryChangeId(primaryId ?? selectedIds.at(-1) ?? '')
  }, [])

  return {
    selectedChangeIds,
    primaryChangeId,
    selectedChange,
    selectedChangeFolder,
    selectChangeFiles
  }
}

interface UseLocalChangeActionsOptions {
  applicationMode: ApplicationMode
  activeSnapshot?: RepositorySnapshot
  activeRepository: Repository
  selectedRevision: Revision | null
  revisionDiffSource: string | null
  diffPreferences: DiffPreferences
  defaultIdentity: string
  notify: AppNotify
  runRepositoryMutation: RunRepositoryMutation
  upsertSnapshot: (snapshot: RepositorySnapshot) => void
  setActiveView: (view: NavigationView) => void
}

/**
 * 管理本地更改的对象选区、文件历史和所有真实写操作。
 *
 * 组件只接收已经绑定仓库上下文的动作；浏览器演示状态与真实 Lore 调用在这里明确
 * 分流，仓库串行门闩及最终快照刷新继续由 `runRepositoryMutation` 统一保证。
 */
export function useLocalChangeActions({
  applicationMode,
  activeSnapshot,
  activeRepository,
  selectedRevision,
  revisionDiffSource,
  diffPreferences,
  defaultIdentity,
  notify,
  runRepositoryMutation,
  upsertSnapshot,
  setActiveView
}: UseLocalChangeActionsOptions) {
  const [fileHistoryRequest, setFileHistoryRequest] = useState<{
    file: RepositoryFileReference
    mode: 'timeline' | 'history'
  } | null>(null)
  const [fileHistoryEntries, setFileHistoryEntries] = useState<FileHistoryEntry[]>([])
  const [fileHistoryLoading, setFileHistoryLoading] = useState(false)
  const [fileHistoryError, setFileHistoryError] = useState<string | null>(null)

  /** 对明确文件集合执行暂存或取消暂存；混合选区由菜单预先拆分。 */
  const stageChangeFiles = useCallback(
    async (files: ChangeFile[], staged: boolean) => {
      if (!activeSnapshot || files.length === 0) return
      const ids = new Set(files.map((file) => file.id))
      const paths = files.map(changeFilePath)
      if (applicationMode === 'browser-demo') {
        upsertSnapshot({
          ...activeSnapshot,
          changes: activeSnapshot.changes.map((file) => (ids.has(file.id) ? { ...file, staged } : file))
        })
        return
      }

      await runRepositoryMutation(
        staged ? 'stageFiles' : 'unstageFiles',
        (repository) => (staged ? stagePaths(repository.path, paths) : unstagePaths(repository.path, paths)),
        operationMessage('status.fileCountWithPath', { count: files.length, path: paths[0] }),
        'changes'
      )
    },
    [activeSnapshot, applicationMode, runRepositoryMutation, upsertSnapshot]
  )

  const stageAll = useCallback(
    async (staged: boolean) => {
      if (!activeSnapshot) return
      if (applicationMode === 'browser-demo') {
        upsertSnapshot({
          ...activeSnapshot,
          changes: setEveryDemoFileStaged(activeSnapshot.changes, staged)
        })
        return
      }

      await runRepositoryMutation(
        staged ? 'stageAll' : 'unstageAll',
        (repository) => (staged ? stagePaths(repository.path, []) : unstagePaths(repository.path, [])),
        operationMessage('status.workspaceFilesReloaded', { count: activeSnapshot.changes.length }),
        'changes'
      )
    },
    [activeSnapshot, applicationMode, runRepositoryMutation, upsertSnapshot]
  )

  /** 对明确选中的冲突文件执行 Lore 原生解决动作。 */
  const resolveConflictFiles = useCallback(
    async (action: Exclude<ConflictAction, 'abort'>, files: ChangeFile[]) => {
      const session = activeSnapshot?.conflictSession
      if (applicationMode !== 'tauri') {
        notify(t('browserDemoMode'), t('browserDemoModeReadLocal_fca5'), 'warning')
        return
      }
      if (!session || session.kind === 'unknown') {
        notify(t('conflictResolution'), t('conflictOperationCouldNotBeIdentified'), 'warning')
        return
      }

      const paths = [...new Set(files.filter((file) => file.conflict).map(changeFilePath))]
      if (paths.length === 0) {
        notify(t('conflictResolution'), t('selectConflictFilesToContinue'), 'warning')
        return
      }
      if (
        action === 'restart' &&
        !confirmLocalized(
          t('confirm.restartConflictFiles', {
            count: paths.length,
            operation: conflictOperationLabel(session.kind),
            repository: activeRepository.name
          })
        )
      ) {
        return
      }

      const operation = session.kind
      await runRepositoryMutation(
        conflictActionLabelKey(action),
        (repository) => runConflictAction(repository.path, operation, action, paths),
        operationMessage('status.conflictFilesUpdated', { count: paths.length }),
        'changes'
      )
    },
    [activeRepository.name, activeSnapshot?.conflictSession, applicationMode, notify, runRepositoryMutation]
  )

  /** Abort 是仓库级恢复动作，必须明确展示仓库和冲突类型。 */
  const abortConflict = useCallback(async () => {
    const session = activeSnapshot?.conflictSession
    if (applicationMode !== 'tauri') {
      notify(t('browserDemoMode'), t('browserDemoModeReadLocal_fca5'), 'warning')
      return
    }
    if (!session || session.kind === 'unknown') {
      notify(t('conflictResolution'), t('conflictOperationCouldNotBeIdentified'), 'warning')
      return
    }
    if (
      !confirmLocalized(
        t('confirm.abortConflictOperation', {
          repository: activeRepository.name,
          operation: conflictOperationLabel(session.kind)
        })
      )
    ) {
      return
    }

    const operation = session.kind
    await runRepositoryMutation(
      'abortConflictOperation',
      (repository) => runConflictAction(repository.path, operation, 'abort'),
      operationMessage('status.conflictOperationAborted'),
      'changes'
    )
  }, [activeRepository.name, activeSnapshot?.conflictSession, applicationMode, notify, runRepositoryMutation])

  const openChangeFile = useCallback(
    async (file: ChangeFile) => {
      if (applicationMode === 'browser-demo') {
        notify(t('browserDemoMode'), t('status.demoWouldOpenWithSystem', { path: changeFilePath(file) }), 'warning')
        return
      }
      try {
        await openWorkspaceFile(activeRepository.path, changeFilePath(file))
      } catch (error) {
        notify(t('unableToOpenFile'), readErrorMessage(error), 'warning')
      }
    },
    [activeRepository.path, applicationMode, notify]
  )

  const readChangePatches = useCallback(
    async (files: ChangeFile[]) => {
      if (applicationMode === 'browser-demo') return files.map(createDemoWorkingTreeDiff)
      return loadWorkingTreeDiff(activeRepository.path, files.map(changeFilePath), diffPreferences)
    },
    [activeRepository.path, applicationMode, diffPreferences]
  )

  const openWorkspaceChangeExternally = useCallback(
    async (file: ChangeFile, tool: ExternalDiffToolPreference) => {
      const workspaceRevision = activeSnapshot?.repository.revision
      if (!workspaceRevision) {
        notify(t('unableToOpenExternalDiff'), t('currentWorkspaceRevisionAnchor_7eed'), 'warning')
        return
      }
      const relativePath = changeFilePath(file)
      try {
        if (applicationMode === 'browser-demo') {
          notify(t('browserDemoMode'), `${tool.name} · ${relativePath}`, 'warning')
          return
        }
        const result = await openExternalDiff(
          createWorkspaceExternalDiffRequest(activeRepository.path, workspaceRevision, file, tool, {
            before:
              file.status === 'added'
                ? t('emptyFileVersion')
                : `${file.previousPath || relativePath} · ${workspaceRevision.slice(0, 8)}`,
            after: file.status === 'deleted' ? t('emptyFileVersion') : `${relativePath} · ${t('workspace')}`
          })
        )
        notify(t('externalDiff'), `${result.toolName} · PID ${result.processId}`, 'success')
      } catch (error) {
        notify(t('unableToOpenExternalDiff'), readErrorMessage(error), 'warning')
      }
    },
    [activeRepository.path, activeSnapshot?.repository.revision, applicationMode, notify]
  )

  /** 比较 Revision Changes 当前真实基线与目标 Revision，不回退到固定第一父节点。 */
  const openRevisionChangeExternally = useCallback(
    async (file: ChangeFile, tool: ExternalDiffToolPreference) => {
      if (!selectedRevision) return
      const relativePath = changeFilePath(file)
      try {
        if (applicationMode === 'browser-demo') {
          notify(t('browserDemoMode'), `${tool.name} · ${relativePath}`, 'warning')
          return
        }
        const result = await openExternalDiff(
          createRevisionExternalDiffRequest(
            activeRepository.path,
            revisionDiffSource,
            selectedRevision.id,
            file,
            tool,
            {
              before:
                file.status === 'added' || !revisionDiffSource
                  ? t('emptyFileVersion')
                  : `${file.previousPath || relativePath} · ${revisionDiffSource.slice(0, 8)}`,
              after: file.status === 'deleted' ? t('emptyFileVersion') : `${relativePath} · ${selectedRevision.shortId}`
            }
          )
        )
        notify(t('externalDiff'), `${result.toolName} · PID ${result.processId}`, 'success')
      } catch (error) {
        notify(t('unableToOpenExternalDiff'), readErrorMessage(error), 'warning')
      }
    },
    [activeRepository.path, applicationMode, notify, revisionDiffSource, selectedRevision]
  )

  const openConflictExternally = useCallback(
    async (file: ChangeFile, tool: ExternalDiffToolPreference) => {
      const session = activeSnapshot?.conflictSession
      if (!session?.incomingRevision) {
        notify(t('unableToOpenExternalMerge'), t('externalMergeRequiresIncomingRevision'), 'warning')
        return
      }
      try {
        if (applicationMode === 'browser-demo') return
        const result = await openExternalMerge(
          createExternalMergeRequest(
            activeRepository.path,
            file,
            tool,
            session.currentRevision,
            session.incomingRevision,
            {
              base: t('mergeBaseVersion'),
              local: t('mergeLocalVersion'),
              remote: t('mergeRemoteVersion'),
              merged: t('mergeResultVersion')
            }
          )
        )
        notify(t('externalMerge'), `${result.toolName} · PID ${result.processId}`, 'success')
      } catch (error) {
        notify(t('unableToOpenExternalMerge'), readErrorMessage(error), 'warning')
      }
    },
    [activeRepository.path, activeSnapshot?.conflictSession, applicationMode, notify]
  )

  const saveChangesPatch = useCallback(
    async (files: ChangeFile[]) => {
      try {
        const patch = combineUnifiedPatches(await readChangePatches(files))
        const fileName = files.length === 1 ? files[0].name : `workspace-${files.length}-files`
        if (applicationMode === 'browser-demo') {
          notify(t('browserDemoMode'), t('status.demoWouldSavePatchDialog', { count: patch.length }), 'warning')
          return
        }
        const path = await savePatchFile(fileName, patch)
        if (path) notify(t('patchSaved'), path, 'success')
      } catch (error) {
        notify(t('unableToSavePatch'), readErrorMessage(error), 'warning')
      }
    },
    [applicationMode, notify, readChangePatches]
  )

  const discardChangeFiles = useCallback(
    async (files: ChangeFile[]) => {
      if (!activeSnapshot || files.length === 0) return
      const paths = files.map(changeFilePath)
      const confirmed = confirmLocalized(
        [
          t('confirm.discardLocalChanges', { count: files.length }),
          '',
          paths.slice(0, 8).join('\n'),
          paths.length > 8 ? t('status.andMoreFiles', { count: paths.length - 8 }) : '',
          '',
          t('confirm.discardAddedDeleted')
        ]
          .filter((line, index, lines) => line !== '' || (lines[index - 1] !== '' && index !== 0))
          .join('\n')
          .replace(/\n{3,}/g, '\n\n')
      )
      if (!confirmed) return

      if (applicationMode === 'browser-demo') {
        const ids = new Set(files.map((file) => file.id))
        upsertSnapshot({
          ...activeSnapshot,
          changes: activeSnapshot.changes.filter((file) => !ids.has(file.id))
        })
        notify(t('demoChangesDiscarded'), t('status.demoFilesRemoved', { count: files.length }), 'success')
        return
      }

      const currentRevision = activeSnapshot.repository.revision
      if (!currentRevision) {
        notify(t('unableToDiscardChanges'), t('currentWorkspaceBaselineRevision_63d7'), 'warning')
        return
      }
      await runRepositoryMutation(
        'discardLocalChanges',
        (repository) => discardWorkspaceFiles(repository.path, paths, currentRevision),
        operationMessage('status.filesRestoredTo', { count: files.length, target: currentRevision.slice(0, 8) }),
        'changes'
      )
    },
    [activeSnapshot, applicationMode, notify, runRepositoryMutation, upsertSnapshot]
  )

  const ignoreChangeFiles = useCallback(
    async (files: ChangeFile[], byExtension: boolean) => {
      if (!activeSnapshot || files.length === 0) return
      const paths = files.map(changeFilePath)
      if (applicationMode === 'browser-demo') {
        notify(
          t('browserDemoMode'),
          t('status.demoWouldAppendIgnoreRule', { kind: byExtension ? t('extension') : t('path') }),
          'warning'
        )
        return
      }
      await runRepositoryMutation(
        byExtension ? 'ignoreFileExtension' : 'ignoreFilePath',
        (repository) => ignoreWorkspacePaths(repository.path, paths, byExtension),
        operationMessage('loreignoreUpdatedTrackedFilesStill_c80a'),
        'changes'
      )
    },
    [activeSnapshot, applicationMode, notify, runRepositoryMutation]
  )

  const openFileHistory = useCallback(
    async (file: RepositoryFileReference, mode: 'timeline' | 'history', startRevision?: string) => {
      setFileHistoryRequest({ file, mode })
      setFileHistoryEntries([])
      setFileHistoryError(null)
      setFileHistoryLoading(false)
      if (!activeSnapshot) return
      if (applicationMode === 'browser-demo') {
        setFileHistoryEntries(
          activeSnapshot.revisions.slice(0, 6).map((revision, index) => ({
            path: changeFilePath(file),
            revision: revision.id,
            revisionNumber: 1482 - index,
            parent: revision.parentIds ?? [],
            size: 0,
            action: index === 5 ? 'add' : 'keep'
          }))
        )
        return
      }
      try {
        setFileHistoryLoading(true)
        setFileHistoryEntries(
          await loadFileHistory(activeSnapshot.repository.path, changeFilePath(file), {
            branch: activeSnapshot.repository.branch,
            revision: startRevision
          })
        )
      } catch (error) {
        setFileHistoryError(readErrorMessage(error))
      } finally {
        setFileHistoryLoading(false)
      }
    },
    [activeSnapshot, applicationMode]
  )

  const closeFileHistory = useCallback(() => {
    setFileHistoryRequest(null)
  }, [])

  const createRevision = useCallback(
    async (message: string) => {
      if (!activeSnapshot) return
      if (applicationMode === 'browser-demo') {
        notify(t('revisionCreated'), message, 'success')
        upsertSnapshot({
          ...activeSnapshot,
          changes: activeSnapshot.changes.filter((file) => !file.staged)
        })
        setActiveView('history')
        return
      }

      await runRepositoryMutation(
        'createRevision',
        (repository) => commitRevision(repository.path, message, defaultIdentity),
        message,
        'history'
      )
    },
    [activeSnapshot, applicationMode, defaultIdentity, notify, runRepositoryMutation, setActiveView, upsertSnapshot]
  )

  return {
    fileHistoryRequest,
    fileHistoryEntries,
    fileHistoryLoading,
    fileHistoryError,
    stageChangeFiles,
    stageAll,
    resolveConflictFiles,
    abortConflict,
    openChangeFile,
    openWorkspaceChangeExternally,
    openRevisionChangeExternally,
    openConflictExternally,
    saveChangesPatch,
    discardChangeFiles,
    ignoreChangeFiles,
    openFileHistory,
    closeFileHistory,
    createRevision
  }
}
