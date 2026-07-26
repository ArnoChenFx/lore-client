import { useCallback, useEffect, useReducer } from 'react'

import type { SettingsCategory } from './components/SettingsDialog'

export interface AppOverlayState {
  commandPaletteOpen: boolean
  serverDialogOpen: boolean
  settingsOpen: boolean
  settingsInitialCategory: SettingsCategory
  updateDialogOpen: boolean
  searchOpen: boolean
  operationsOpen: boolean
  aboutOpen: boolean
}

type BooleanOverlayKey = Exclude<keyof AppOverlayState, 'settingsInitialCategory'>

type AppOverlayAction =
  | { type: 'set'; key: BooleanOverlayKey; open: boolean }
  | { type: 'settingsCategory'; category: SettingsCategory }
  | { type: 'showUpdate' }

export const initialAppOverlayState: AppOverlayState = {
  commandPaletteOpen: false,
  serverDialogOpen: false,
  settingsOpen: false,
  settingsInitialCategory: 'general',
  updateDialogOpen: false,
  searchOpen: false,
  operationsOpen: false,
  aboutOpen: false
}

/**
 * 弹层状态转换保持纯函数，便于验证一次动作需要同时关闭设置并打开更新弹层的原子语义。
 */
export function appOverlayStateReducer(state: AppOverlayState, action: AppOverlayAction): AppOverlayState {
  if (action.type === 'set') {
    if (state[action.key] === action.open) return state
    return { ...state, [action.key]: action.open }
  }
  if (action.type === 'settingsCategory') {
    if (state.settingsInitialCategory === action.category) return state
    return { ...state, settingsInitialCategory: action.category }
  }
  return {
    ...state,
    settingsOpen: false,
    updateDialogOpen: true
  }
}

/**
 * 管理跨领域全局弹层的可见状态。
 *
 * 仓库对象菜单、标签编辑等领域上下文仍由各自功能拥有；这里只接收标题栏、命令面板、
 * 设置、更新、搜索、操作中心和关于页等应用级入口，避免形成万能弹层控制器。
 */
export function useAppOverlayState() {
  const [state, dispatch] = useReducer(appOverlayStateReducer, initialAppOverlayState)

  const setCommandPaletteOpen = useCallback(
    (open: boolean) => dispatch({ type: 'set', key: 'commandPaletteOpen', open }),
    []
  )
  const setServerDialogOpen = useCallback(
    (open: boolean) => dispatch({ type: 'set', key: 'serverDialogOpen', open }),
    []
  )
  const setSettingsOpen = useCallback((open: boolean) => dispatch({ type: 'set', key: 'settingsOpen', open }), [])
  const setUpdateDialogOpen = useCallback(
    (open: boolean) => dispatch({ type: 'set', key: 'updateDialogOpen', open }),
    []
  )
  const setSearchOpen = useCallback((open: boolean) => dispatch({ type: 'set', key: 'searchOpen', open }), [])
  const setOperationsOpen = useCallback((open: boolean) => dispatch({ type: 'set', key: 'operationsOpen', open }), [])
  const setAboutOpen = useCallback((open: boolean) => dispatch({ type: 'set', key: 'aboutOpen', open }), [])
  const setSettingsInitialCategory = useCallback(
    (category: SettingsCategory) => dispatch({ type: 'settingsCategory', category }),
    []
  )
  const showUpdate = useCallback(() => dispatch({ type: 'showUpdate' }), [])

  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault()
        setCommandPaletteOpen(true)
      }
      if (event.key === 'Escape') {
        setCommandPaletteOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyboard)
    return () => window.removeEventListener('keydown', handleKeyboard)
  }, [setCommandPaletteOpen])

  return {
    ...state,
    setCommandPaletteOpen,
    setServerDialogOpen,
    setSettingsOpen,
    setSettingsInitialCategory,
    setUpdateDialogOpen,
    setSearchOpen,
    setOperationsOpen,
    setAboutOpen,
    showUpdate
  }
}
