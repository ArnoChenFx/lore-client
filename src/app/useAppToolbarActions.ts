import { useCallback } from 'react'

import { operationMessage } from '../features/operations'
import type { RunRepositoryMutation } from '../features/repository-session'
import type { AppNotify } from '../features/repository-session'
import type { RepositoryToolTab } from '../features/repository-tools'
import { t } from '../i18n'
import { openWorkspace, pushBranch, syncRepository, verifyRepository } from '../services/lore'
import { readErrorMessage } from '../shared/lib'
import type { ApplicationMode, NavigationView, RepositorySnapshot } from '../types'
import type { SettingsCategory } from './components/SettingsDialog'

interface UseAppToolbarActionsOptions {
  applicationMode: ApplicationMode
  activeSnapshot?: RepositorySnapshot
  openRepository: () => Promise<void>
  openServer: () => Promise<void>
  openRepositoryTool: (tab: RepositoryToolTab) => Promise<void>
  runRepositoryMutation: RunRepositoryMutation
  resetLayout: () => void
  setActiveView: (view: NavigationView) => void
  setCommandPaletteOpen: (open: boolean) => void
  setSettingsOpen: (open: boolean) => void
  setSettingsInitialCategory: (category: SettingsCategory) => void
  setSearchOpen: (open: boolean) => void
  setOperationsOpen: (open: boolean) => void
  setAboutOpen: (open: boolean) => void
  notify: AppNotify
}

/**
 * 把窗口工具栏命令映射到明确的应用动作。
 *
 * 工具栏只发出稳定字符串命令；本控制器负责选择仓库工具页签、一级工作区或真实 Lore
 * 写操作。页面组件因此不需要理解每个命令的跨领域路由规则。
 */
export function useAppToolbarActions({
  applicationMode,
  activeSnapshot,
  openRepository,
  openServer,
  openRepositoryTool,
  runRepositoryMutation,
  resetLayout,
  setActiveView,
  setCommandPaletteOpen,
  setSettingsOpen,
  setSettingsInitialCategory,
  setSearchOpen,
  setOperationsOpen,
  setAboutOpen,
  notify
}: UseAppToolbarActionsOptions) {
  const openCurrentWorkspace = useCallback(async () => {
    if (!activeSnapshot) {
      await openRepository()
      return
    }
    if (applicationMode !== 'tauri') {
      notify(t('browserDemoMode'), activeSnapshot.repository.path, 'info')
      return
    }
    try {
      await openWorkspace(activeSnapshot.repository.path)
    } catch (error) {
      notify(t('unableToOpenProjectDirectory'), readErrorMessage(error), 'warning')
    }
  }, [activeSnapshot, applicationMode, notify, openRepository])

  const handleToolbarAction = useCallback(
    async (action: string) => {
      if (action === 'repository') return openRepository()
      if (action === 'server') return openServer()
      if (action === 'view') {
        if (applicationMode !== 'tauri') {
          notify(t('browserDemoMode'), t('startDesktopAppManageRepositoryView'), 'warning')
          return
        }
        return openRepositoryTool('view')
      }
      if (action === 'commands') return setCommandPaletteOpen(true)
      if (action === 'settings') {
        setSettingsInitialCategory('general')
        return setSettingsOpen(true)
      }
      if (action === 'search') {
        if (!activeSnapshot) return openRepository()
        setSearchOpen(true)
        return
      }
      if (action === 'operations') return setOperationsOpen(true)
      if (action === 'about') return setAboutOpen(true)
      if (action === 'open-workspace') return openCurrentWorkspace()
      if (action === 'reset-layout') {
        resetLayout()
        notify(t('workspaceLayoutRestored'), t('sidebarInspectorRestoredDefaultWidths_744b'), 'success')
        return
      }
      if (action === 'revision') {
        if (!activeSnapshot) return openRepository()
        setActiveView('changes')
        return
      }
      if (action === 'branch') {
        if (!activeSnapshot) return openRepository()
        setActiveView('branches')
        return
      }
      if (action === 'layers') return openRepositoryTool('layers')
      if (action === 'links') return openRepositoryTool('links')
      if (action === 'locks') return openRepositoryTool('locks')
      if (action === 'dependencies') return openRepositoryTool('dependencies')
      if (action === 'branch-collaboration') return openRepositoryTool('collaboration')
      if (action === 'revision-recovery') return openRepositoryTool('revision')
      if (action === 'accounts') return openRepositoryTool('accounts')
      if (action === 'maintenance') return openRepositoryTool('maintenance')
      if (action === 'verify') {
        return runRepositoryMutation(
          'verifyRepository',
          (repository) => verifyRepository(repository.path),
          operationMessage('loreCoreFinishedReadConsistency_86d2')
        )
      }
      if ((action === 'sync' || action === 'hydrate') && applicationMode === 'tauri') {
        return runRepositoryMutation(
          action === 'hydrate' ? 'fetchContent' : 'sync',
          (repository) => syncRepository(repository.path),
          t('workingDirectoryBranchRequiredContent_6d44')
        )
      }
      if (action === 'push' && applicationMode === 'tauri') {
        return runRepositoryMutation(
          'push',
          (repository) => pushBranch(repository.path, repository.branch),
          operationMessage('remoteBranchAdvanced')
        )
      }
      if (applicationMode === 'browser-demo') {
        notify(t('browserDemoMode'), t('loreWriteOperationRunsTauri_0117'), 'warning')
      }
    },
    [
      activeSnapshot,
      applicationMode,
      notify,
      openCurrentWorkspace,
      openRepository,
      openRepositoryTool,
      openServer,
      resetLayout,
      runRepositoryMutation,
      setAboutOpen,
      setActiveView,
      setCommandPaletteOpen,
      setOperationsOpen,
      setSearchOpen,
      setSettingsInitialCategory,
      setSettingsOpen
    ]
  )

  return {
    openCurrentWorkspace,
    handleToolbarAction
  }
}
