import { useCallback, useReducer } from 'react'

import { isBranchAlreadyAtWorkspaceRevision } from '../features/branches'
import { operationMessage } from '../features/operations'
import type { AppNotify, RunRepositoryMutation } from '../features/repository-session'
import { resolveRevisionCheckoutBranch } from '../features/revision-inspector'
import type { TagMenuRequest } from '../features/tags'
import { confirmLocalized, t } from '../i18n'
import {
  archiveBranch,
  cherryPickRevision,
  checkoutRevision,
  createBranchFromSource,
  createTag,
  deleteTag,
  mergeBranch,
  pushBranch,
  revertRevision,
  switchBranch,
  updateTag
} from '../services/lore'
import type { ContextMenuPoint, VersionMenuRequest } from '../shared/ui'
import type {
  ApplicationMode,
  Branch,
  BranchCreationSource,
  LoreTag,
  NavigationView,
  Repository,
  RepositorySnapshot,
  Revision,
  TagCreationSource
} from '../types'

interface VersionActionState {
  branchCreateSource: BranchCreationSource | null
  branchArchiveTarget: Branch | null
  tagCreateSource: TagCreationSource | null
  editingTag: LoreTag | null
  tagDetails: LoreTag | null
  tagMenu: TagMenuRequest | null
  versionMenu: VersionMenuRequest | null
}

type VersionActionStateAction =
  | { type: 'openBranchCreate'; source: BranchCreationSource }
  | { type: 'closeBranchCreate' }
  | { type: 'openBranchArchive'; branch: Branch }
  | { type: 'closeBranchArchive' }
  | { type: 'openTagCreate'; source: TagCreationSource }
  | { type: 'openTagEdit'; tag: LoreTag }
  | { type: 'closeTagDialog' }
  | { type: 'showTagDetails'; tag: LoreTag | null }
  | { type: 'openTagMenu'; request: TagMenuRequest }
  | { type: 'closeTagMenu' }
  | { type: 'openVersionMenu'; request: VersionMenuRequest }
  | { type: 'closeVersionMenu' }

export const INITIAL_VERSION_ACTION_STATE: VersionActionState = {
  branchCreateSource: null,
  branchArchiveTarget: null,
  tagCreateSource: null,
  editingTag: null,
  tagDetails: null,
  tagMenu: null,
  versionMenu: null
}

/**
 * 版本对象弹层共享一个纯状态机。
 *
 * 创建标签与编辑标签互斥，进入编辑时同时关闭详情；这类跨弹层不变量不能分散成多次
 * `setState`，否则后续新增入口时很容易留下重叠弹层。
 */
export function versionActionStateReducer(
  state: VersionActionState,
  action: VersionActionStateAction
): VersionActionState {
  if (action.type === 'openBranchCreate') {
    return { ...state, branchCreateSource: action.source }
  }
  if (action.type === 'closeBranchCreate') {
    return { ...state, branchCreateSource: null }
  }
  if (action.type === 'openBranchArchive') {
    return { ...state, branchArchiveTarget: action.branch, versionMenu: null }
  }
  if (action.type === 'closeBranchArchive') {
    return { ...state, branchArchiveTarget: null }
  }
  if (action.type === 'openTagCreate') {
    return { ...state, tagCreateSource: action.source, editingTag: null }
  }
  if (action.type === 'openTagEdit') {
    return { ...state, tagCreateSource: null, editingTag: action.tag, tagDetails: null }
  }
  if (action.type === 'closeTagDialog') {
    return { ...state, tagCreateSource: null, editingTag: null }
  }
  if (action.type === 'showTagDetails') {
    return { ...state, tagDetails: action.tag }
  }
  if (action.type === 'openTagMenu') {
    return { ...state, tagMenu: action.request }
  }
  if (action.type === 'closeTagMenu') {
    return { ...state, tagMenu: null }
  }
  if (action.type === 'openVersionMenu') {
    return { ...state, versionMenu: action.request }
  }
  return { ...state, versionMenu: null }
}

interface UseAppVersionActionsOptions {
  applicationMode: ApplicationMode
  activeSnapshot?: RepositorySnapshot
  activeRepository: Repository
  notify: AppNotify
  runRepositoryMutation: RunRepositoryMutation
  setActiveView: (view: NavigationView) => void
  setSelectedRevisionId: (revisionId: string) => void
  setSelectedBranchId: (branchId: string) => void
  setSelectedTagId: (tagId: string) => void
  revealRevision: (revisionId: string) => void
}

/**
 * 只接受当前快照中真实存在的 Branch latest。
 *
 * Lore 历史查询可能被上限或过滤边界截断；返回 `undefined` 比让 Inspector 隐式回退
 * 到第一条 Revision 更安全，也能避免把错误行表现成定位成功。
 */
export function resolveSidebarBranchRevisionId(branch: Branch, revisions: readonly Revision[]): string | undefined {
  if (!branch.latest) return undefined
  return revisions.some((revision) => revision.id === branch.latest) ? branch.latest : undefined
}

/**
 * 集中管理 Revision、Branch 与 Tag 的应用级操作编排。
 *
 * 这里负责精确来源、确认文案、浏览器演示反馈和写操作参数；仓库串行门闩、最终快照
 * 刷新及冲突恢复继续由调用方提供的 `runRepositoryMutation` 保证。
 */
export function useAppVersionActions({
  applicationMode,
  activeSnapshot,
  activeRepository,
  notify,
  runRepositoryMutation,
  setActiveView,
  setSelectedRevisionId,
  setSelectedBranchId,
  setSelectedTagId,
  revealRevision
}: UseAppVersionActionsOptions) {
  const [state, dispatch] = useReducer(versionActionStateReducer, INITIAL_VERSION_ACTION_STATE)

  const openBranchCreateDialog = useCallback((source: BranchCreationSource) => {
    dispatch({ type: 'openBranchCreate', source })
  }, [])

  const closeBranchCreateDialog = useCallback(() => {
    dispatch({ type: 'closeBranchCreate' })
  }, [])

  const closeBranchArchiveDialog = useCallback(() => {
    dispatch({ type: 'closeBranchArchive' })
  }, [])

  const openTagCreateDialog = useCallback((source: TagCreationSource) => {
    dispatch({ type: 'openTagCreate', source })
  }, [])

  const closeTagDialog = useCallback(() => {
    dispatch({ type: 'closeTagDialog' })
  }, [])

  const showTagDetails = useCallback((tag: LoreTag | null) => {
    dispatch({ type: 'showTagDetails', tag })
  }, [])

  const closeTagMenu = useCallback(() => {
    dispatch({ type: 'closeTagMenu' })
  }, [])

  const closeVersionMenu = useCallback(() => {
    dispatch({ type: 'closeVersionMenu' })
  }, [])

  const createNewBranch = useCallback(
    async (name: string) => {
      const source = state.branchCreateSource
      if (!activeSnapshot || !source) return
      const previousRevision = activeSnapshot.repository.revision
      if (!previousRevision) {
        notify(t('unableToCreateBranch'), t('currentWorkspaceRevisionAnchor_7eed'), 'warning')
        return
      }
      const alreadyExists = activeSnapshot.branches.some(
        (branch) => branch.name.toLocaleLowerCase() === name.toLocaleLowerCase()
      )
      if (alreadyExists) {
        notify(t('branchNameAlreadyExists'), t('status.chooseAnotherName', { name }), 'warning')
        return
      }
      if (applicationMode === 'browser-demo') {
        closeBranchCreateDialog()
        notify(
          t('browserDemoMode'),
          t('status.demoWouldCreateBranch', {
            source: source.branch,
            revision: source.revision.slice(0, 8),
            name
          }),
          'warning'
        )
        return
      }

      const created = await runRepositoryMutation(
        'createBranch',
        (repository) =>
          createBranchFromSource(
            repository.path,
            name,
            source.branch,
            source.revision,
            repository.branch,
            previousRevision
          ),
        operationMessage('status.createdBranchAttached', {
          source: source.branch,
          revision: source.revision.slice(0, 8),
          name
        }),
        'branches'
      )
      if (created) closeBranchCreateDialog()
    },
    [activeSnapshot, applicationMode, closeBranchCreateDialog, notify, runRepositoryMutation, state.branchCreateSource]
  )

  /** 顶部入口始终从当前工作区锚点创建，不从历史选区猜测来源。 */
  const openCurrentBranchCreateDialog = useCallback(() => {
    const revision = activeSnapshot?.repository.revision
    if (!revision) {
      notify(t('unableToCreateBranch'), t('createAtLeastOneRevisionFirst'), 'warning')
      return
    }
    openBranchCreateDialog({
      kind: 'workspace',
      branch: activeRepository.branch,
      revision
    })
  }, [activeRepository.branch, activeSnapshot?.repository.revision, notify, openBranchCreateDialog])

  /** 顶部标签入口同样固定使用当前工作区 Revision。 */
  const openCurrentTagCreateDialog = useCallback(() => {
    const revision = activeSnapshot?.repository.revision
    if (!revision) {
      notify(t('unableToCreateTag'), t('createAtLeastOneRevisionFirst'), 'warning')
      return
    }
    openTagCreateDialog({
      kind: 'workspace',
      branch: activeRepository.branch,
      revision
    })
  }, [activeRepository.branch, activeSnapshot?.repository.revision, notify, openTagCreateDialog])

  const createNewTag = useCallback(
    async (name: string, message: string) => {
      const source = state.tagCreateSource
      if (!activeSnapshot || !source) return
      const alreadyExists = activeSnapshot.tags.some((tag) => tag.name.toLocaleLowerCase() === name.toLocaleLowerCase())
      if (alreadyExists) {
        notify(t('tagNameAlreadyExists'), t('status.chooseAnotherName', { name }), 'warning')
        return
      }
      if (applicationMode === 'browser-demo') {
        closeTagDialog()
        notify(
          t('browserDemoMode'),
          t('status.demoWouldCreateTag', {
            source: source.branch,
            revision: source.revision.slice(0, 8),
            name
          }),
          'warning'
        )
        return
      }

      const created = await runRepositoryMutation(
        'createTag',
        (repository) => createTag(repository.path, name, source.branch, source.revision, message),
        operationMessage('status.tagWrittenToMetadata', { name })
      )
      if (created) closeTagDialog()
    },
    [activeSnapshot, applicationMode, closeTagDialog, notify, runRepositoryMutation, state.tagCreateSource]
  )

  const saveTagChanges = useCallback(
    async (name: string, message: string) => {
      const editingTag = state.editingTag
      if (!editingTag) return
      const duplicate = activeSnapshot?.tags.some(
        (tag) => tag.id !== editingTag.id && tag.name.toLocaleLowerCase() === name.toLocaleLowerCase()
      )
      if (duplicate) {
        notify(t('tagNameAlreadyExists'), t('status.chooseAnotherName', { name }), 'warning')
        return
      }
      if (applicationMode === 'browser-demo') {
        closeTagDialog()
        notify(t('browserDemoMode'), t('status.demoWouldRenameTag', { from: editingTag.name, to: name }), 'warning')
        return
      }

      const updated = await runRepositoryMutation(
        'editTag',
        (repository) => updateTag(repository.path, editingTag.id, name, message),
        operationMessage('status.tagUpdatedTo', { from: editingTag.name, to: name })
      )
      if (updated) closeTagDialog()
    },
    [activeSnapshot?.tags, applicationMode, closeTagDialog, notify, runRepositoryMutation, state.editingTag]
  )

  const selectTag = useCallback(
    (tag: LoreTag) => {
      setSelectedTagId(tag.id)
      const revision = activeSnapshot?.revisions.find((item) => item.id === tag.revision)
      if (revision) setSelectedRevisionId(revision.id)
    },
    [activeSnapshot?.revisions, setSelectedRevisionId, setSelectedTagId]
  )

  const locateTagRevision = useCallback(
    (tag: LoreTag) => {
      const revision = activeSnapshot?.revisions.find((item) => item.id === tag.revision)
      if (!revision) {
        notify(
          t('revisionLoadedHistory_5d63'),
          t('status.revisionMaybeNotInBranchHistory', { id: tag.revision.slice(0, 8) }),
          'warning'
        )
        return
      }
      setSelectedTagId(tag.id)
      setSelectedRevisionId(revision.id)
      setActiveView('history')
    },
    [activeSnapshot?.revisions, notify, setActiveView, setSelectedRevisionId, setSelectedTagId]
  )

  /** 已归档分支只允许定位精确 Latest，不能触发检出或隐式恢复。 */
  const locateArchivedBranchRevision = useCallback(
    (branch: Branch) => {
      if (!branch.latest) {
        notify(t('archivedBranchAvailableRevision_62c0'), branch.name, 'warning')
        return
      }
      const revision = activeSnapshot?.revisions.find((item) => item.id === branch.latest)
      if (!revision) {
        notify(
          t('revisionLoadedHistory_5d63'),
          t('status.revisionMaybeNotInHistory', { id: branch.latest.slice(0, 8) }),
          'warning'
        )
        return
      }
      setSelectedBranchId(branch.id)
      setSelectedRevisionId(revision.id)
      setActiveView('history')
    },
    [activeSnapshot?.revisions, notify, setActiveView, setSelectedBranchId, setSelectedRevisionId]
  )

  const openTagContextMenu = useCallback(
    (tag: LoreTag, point: ContextMenuPoint) => {
      selectTag(tag)
      dispatch({ type: 'openTagMenu', request: { tag, ...point } })
    },
    [selectTag]
  )

  const beginEditingTag = useCallback((tag: LoreTag) => {
    dispatch({ type: 'openTagEdit', tag })
  }, [])

  const deleteTagFromMenu = useCallback(
    async (tag: LoreTag) => {
      if (applicationMode === 'browser-demo') {
        notify(t('browserDemoMode'), t('status.demoWouldDeleteTag', { name: tag.name }), 'warning')
        return
      }
      const confirmed = confirmLocalized(
        [
          t('confirm.deleteTag', { name: tag.name }),
          '',
          t('confirm.deleteTagDetail', { revision: tag.revision.slice(0, 8) })
        ].join('\n')
      )
      if (!confirmed) return
      await runRepositoryMutation(
        'deleteTag',
        (repository) => deleteTag(repository.path, tag.id),
        operationMessage('status.tagDeletedFromMetadata', { name: tag.name })
      )
    },
    [applicationMode, notify, runRepositoryMutation]
  )

  const selectBranch = useCallback(
    (branch: Branch) => {
      // 单击只改变选中态；真实检出仅由双击或菜单显式触发。
      setSelectedBranchId(branch.id)
    },
    [setSelectedBranchId]
  )

  const locateSidebarBranchRevision = useCallback(
    (branch: Branch) => {
      // 侧栏单击先保留 Branch 浏览上下文，但绝不把它升级为 Checkout。
      setSelectedBranchId(branch.id)
      const revisionId = resolveSidebarBranchRevisionId(branch, activeSnapshot?.revisions ?? [])
      if (!revisionId) {
        /*
         * 历史可能受 Lore 查询上限约束。目标不在当前真实快照时保持现有 Revision，
         * 不能把第一行或工作区 HEAD 冒充成该 Branch 的 latest。
         */
        return
      }
      revealRevision(revisionId)
    },
    [activeSnapshot?.revisions, revealRevision, setSelectedBranchId]
  )

  const openRevisionContextMenu = useCallback(
    (revision: Revision, point: ContextMenuPoint) => {
      setSelectedRevisionId(revision.id)
      dispatch({ type: 'openVersionMenu', request: { kind: 'revision', revision, ...point } })
    },
    [setSelectedRevisionId]
  )

  const openBranchContextMenu = useCallback(
    (branch: Branch, point: ContextMenuPoint) => {
      setSelectedBranchId(branch.id)
      dispatch({ type: 'openVersionMenu', request: { kind: 'branch', branch, ...point } })
    },
    [setSelectedBranchId]
  )

  const openRevisionInInspector = useCallback(
    (revision: Revision) => {
      setActiveView('history')
      setSelectedRevisionId(revision.id)
    },
    [setActiveView, setSelectedRevisionId]
  )

  const checkoutRevisionFromList = useCallback(
    async (revision: Revision) => {
      if (revision.id === activeSnapshot?.repository.revision) {
        notify(t('currentRevision'), t('status.alreadyInstanceAnchor', { id: revision.shortId }), 'info')
        return
      }
      const checkoutBranch = resolveRevisionCheckoutBranch(
        revision,
        activeSnapshot?.branches ?? [],
        activeSnapshot?.revisions ?? [],
        activeRepository.branch
      )
      if (applicationMode !== 'tauri') {
        notify(
          t('browserDemoMode'),
          t('status.demoWouldCheckoutRevision', { branch: checkoutBranch, revision: revision.shortId }),
          'warning'
        )
        return
      }

      await runRepositoryMutation(
        'checkOutRevision',
        (repository) => checkoutRevision(repository.path, checkoutBranch, revision.id),
        operationMessage('status.branchSyncedToRevision', { branch: checkoutBranch, revision: revision.shortId }),
        'history'
      )
    },
    [activeRepository.branch, activeSnapshot, applicationMode, notify, runRepositoryMutation]
  )

  const cherryPickFromMenu = useCallback(
    async (revision: Revision) => {
      if (applicationMode !== 'tauri') {
        notify(
          t('browserDemoMode'),
          t('status.demoWouldCherryPick', { revision: revision.shortId, branch: activeRepository.branch }),
          'warning'
        )
        return
      }
      const confirmed = confirmLocalized(
        [
          t('confirm.cherryPickRevision', { revision: revision.shortId, branch: activeRepository.branch }),
          '',
          t('conflictsLoreCreatesNewRevision_c34c')
        ].join('\n')
      )
      if (!confirmed) return

      await runRepositoryMutation(
        'cherryPickRevision',
        (repository) => cherryPickRevision(repository.path, revision.id),
        operationMessage('status.revisionAppliedTo', {
          revision: revision.shortId,
          branch: activeRepository.branch
        }),
        'history'
      )
    },
    [activeRepository.branch, applicationMode, notify, runRepositoryMutation]
  )

  const revertFromMenu = useCallback(
    async (revision: Revision) => {
      if (applicationMode !== 'tauri') {
        notify(
          t('browserDemoMode'),
          t('status.demoWouldRevert', { branch: activeRepository.branch, revision: revision.shortId }),
          'warning'
        )
        return
      }
      const confirmed = confirmLocalized(
        [
          t('confirm.revertRevision', { revision: revision.shortId }),
          '',
          t('confirm.revertDetail', { branch: activeRepository.branch })
        ].join('\n')
      )
      if (!confirmed) return

      await runRepositoryMutation(
        'revertRevision',
        (repository) => revertRevision(repository.path, revision.id),
        operationMessage('status.revertRevisionCreated', { revision: revision.shortId }),
        'history'
      )
    },
    [activeRepository.branch, applicationMode, notify, runRepositoryMutation]
  )

  const switchBranchFromMenu = useCallback(
    async (branch: Branch) => {
      if (isBranchAlreadyAtWorkspaceRevision(branch, activeRepository)) {
        notify(t('currentBranch'), t('status.alreadyWorkspaceBranch', { name: branch.name }), 'info')
        return
      }
      if (applicationMode !== 'tauri') {
        notify(
          t('browserDemoMode'),
          branch.remote
            ? t('status.demoWouldAttachRemote', { name: branch.name })
            : t('status.demoWouldSwitchWorkspace', { name: branch.name }),
          'warning'
        )
        return
      }
      await runRepositoryMutation(
        branch.remote ? 'attachRemoteBranch' : 'switchBranch',
        (repository) => switchBranch(repository.path, branch.name, branch.latest),
        branch.remote
          ? operationMessage('status.workspaceAttachedRemote', { name: branch.name })
          : operationMessage('status.workspaceSwitchedTo', { name: branch.name }),
        'history'
      )
    },
    [activeRepository, applicationMode, notify, runRepositoryMutation]
  )

  const pushBranchFromMenu = useCallback(
    async (branch: Branch) => {
      if (applicationMode !== 'tauri') {
        notify(t('browserDemoMode'), t('status.demoWouldPushToRemote', { name: branch.name }), 'warning')
        return
      }
      await runRepositoryMutation(
        'pushBranch',
        (repository) => pushBranch(repository.path, branch.name),
        operationMessage('status.pushedToRemote', { name: branch.name }),
        'branches'
      )
    },
    [applicationMode, notify, runRepositoryMutation]
  )

  const mergeBranchFromMenu = useCallback(
    async (branch: Branch) => {
      if (applicationMode !== 'tauri') {
        notify(
          t('browserDemoMode'),
          t('status.demoWouldMergeInto', { source: branch.name, target: activeRepository.branch }),
          'warning'
        )
        return
      }
      const confirmed = confirmLocalized(
        [
          t('confirm.mergeBranch', { source: branch.name, target: activeRepository.branch }),
          '',
          t('conflictsLoreCreatesMergeRevision_c315')
        ].join('\n')
      )
      if (!confirmed) return

      await runRepositoryMutation(
        'mergeBranch',
        (repository) => mergeBranch(repository.path, branch.name),
        operationMessage('status.mergedInto', { source: branch.name, target: activeRepository.branch }),
        'history'
      )
    },
    [activeRepository.branch, applicationMode, notify, runRepositoryMutation]
  )

  const archiveBranchFromMenu = useCallback(
    (branch: Branch) => {
      if (applicationMode !== 'tauri') {
        notify(t('browserDemoMode'), t('status.demoWouldArchiveBranch', { name: branch.name }), 'warning')
        return
      }
      // 归档范围（是否同时归档 Layer）在正式弹层中决定，不使用 window.confirm，
      // 否则无法承载“同时归档所有 Layer”的显式选择。
      dispatch({ type: 'openBranchArchive', branch })
    },
    [applicationMode, notify]
  )

  const confirmBranchArchive = useCallback(
    async (branch: Branch, includeLayers: boolean) => {
      if (applicationMode !== 'tauri') return
      const succeeded = await runRepositoryMutation(
        'archiveBranch',
        (repository) => archiveBranch(repository.path, branch.name, includeLayers),
        operationMessage(
          includeLayers ? 'status.archivedWithLayers' : 'status.archived',
          { name: branch.name }
        ),
        'branches'
      )
      // 与创建分支一致：仅在真实成功后关闭弹层，失败时保留上下文供用户重试。
      if (succeeded) closeBranchArchiveDialog()
    },
    [applicationMode, closeBranchArchiveDialog, runRepositoryMutation]
  )

  return {
    ...state,
    openBranchCreateDialog,
    closeBranchCreateDialog,
    closeBranchArchiveDialog,
    confirmBranchArchive,
    openTagCreateDialog,
    closeTagDialog,
    showTagDetails,
    closeTagMenu,
    closeVersionMenu,
    createNewBranch,
    openCurrentBranchCreateDialog,
    openCurrentTagCreateDialog,
    createNewTag,
    saveTagChanges,
    selectTag,
    locateTagRevision,
    locateArchivedBranchRevision,
    openTagContextMenu,
    beginEditingTag,
    deleteTagFromMenu,
    selectBranch,
    locateSidebarBranchRevision,
    openRevisionContextMenu,
    openBranchContextMenu,
    openRevisionInInspector,
    checkoutRevisionFromList,
    cherryPickFromMenu,
    revertFromMenu,
    switchBranchFromMenu,
    pushBranchFromMenu,
    mergeBranchFromMenu,
    archiveBranchFromMenu
  }
}
