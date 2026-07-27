import { Bell, CircleHelp, Maximize2, Minus, Moon, PanelsTopLeft, Sun, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { IconButton } from '../../shared/ui'
import type { Repository, ResolvedTheme } from '../../types'

type WindowAction = 'minimize' | 'maximize' | 'close'

async function runWindowAction(action: WindowAction) {
  // 浏览器预览没有 Tauri IPC；此分支让同一套 UI 可在 Vite 中独立验收。
  if (!('__TAURI_INTERNALS__' in window)) return
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const currentWindow = getCurrentWindow()
  if (action === 'minimize') await currentWindow.minimize()
  else if (action === 'close') await currentWindow.close()
  else if (await currentWindow.isMaximized()) await currentWindow.unmaximize()
  else await currentWindow.maximize()
}

interface TitleBarProps {
  repository: Repository
  theme: ResolvedTheme
  operationCount: number
  onAction: (action: string) => void
  onToggleTheme: () => void
}

/** 原生风格标题栏菜单，所有菜单项都映射到可执行的应用命令。 */
export function TitleBar({ repository, theme, operationCount, onAction, onToggleTheme }: TitleBarProps) {
  const { t } = useTranslation()
  // 菜单文案必须在渲染期取 t()，不能写在模块顶层，否则语言切换后仍冻结为导入时语言。
  const menus = [
    {
      id: 'file',
      label: t('files'),
      items: [
        { label: t('openLocalRepository'), action: 'repository' },
        { label: t('browseOrCloneRemoteRepositories_2'), action: 'server' },
        { label: t('openProjectDirectory'), action: 'open-workspace' }
      ]
    },
    {
      id: 'view',
      label: t('view'),
      items: [
        { label: t('toggleDarkLightTheme'), action: 'toggle-theme' },
        { label: t('restoreDefaultPaneWidths'), action: 'reset-layout' },
        { label: t('openCommandPalette'), action: 'commands' }
      ]
    },
    {
      id: 'repository',
      label: t('repository'),
      items: [
        { label: t('syncCurrentRepository'), action: 'sync' },
        { label: t('pushCurrentBranch'), action: 'push' },
        { label: t('verifyRepositoryStatus'), action: 'verify' },
        { label: t('layersAndLinks'), action: 'layers' }
      ]
    },
    {
      id: 'window',
      label: t('window'),
      items: [
        { label: t('minimize'), action: 'window-minimize' },
        { label: t('maximizeRestore'), action: 'window-maximize' }
      ]
    },
    {
      id: 'help',
      label: t('help'),
      items: [
        { label: t('aboutLoreClient'), action: 'about' },
        { label: t('viewOperationHistory'), action: 'operations' }
      ]
    }
  ]
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const menuRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpenMenu(null)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [])

  const runAction = (action: string) => {
    setOpenMenu(null)
    if (action === 'toggle-theme') onToggleTheme()
    else if (action === 'window-minimize') void runWindowAction('minimize')
    else if (action === 'window-maximize') void runWindowAction('maximize')
    else onAction(action)
  }

  return (
    <header className="titlebar">
      <nav ref={menuRef} className="titlebar__menus" aria-label={t('applicationMenu')}>
        {menus.map((menu) => (
          <div key={menu.id} className="titlebar-menu">
            <button
              type="button"
              className={openMenu === menu.id ? 'is-open' : ''}
              aria-expanded={openMenu === menu.id}
              onClick={() => setOpenMenu((value) => (value === menu.id ? null : menu.id))}
            >
              {menu.label}
            </button>
            {openMenu === menu.id && (
              <div className="titlebar-menu__popup">
                {menu.items.map((item) => (
                  <button key={item.action} type="button" onClick={() => runAction(item.action)}>
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </nav>

      <div className="titlebar__drag-region" data-tauri-drag-region>
        <PanelsTopLeft size={14} aria-hidden="true" />
        <span className="titlebar__title">Lore</span>
        <span className="titlebar__separator">/</span>
        <span className="titlebar__workspace">{repository.name}</span>
      </div>

      <div className="titlebar__status">
        <span className="titlebar__connection">
          <i aria-hidden="true" className={repository.online ? '' : 'is-offline'} />
          {repository.remoteState === 'online'
            ? t('remoteAvailable')
            : repository.remoteState === 'unauthorized'
              ? t('remoteAuthenticationRequired')
              : repository.remoteState === 'offline'
                ? t('offline')
                : t('localMode')}
        </span>
        <IconButton
          icon={theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
          label={theme === 'dark' ? t('switchToLightTheme') : t('switchToDarkTheme')}
          onClick={onToggleTheme}
        />
        <IconButton
          icon={<Bell size={14} />}
          label={t('operationHistory')}
          badge={operationCount || undefined}
          onClick={() => onAction('operations')}
        />
        <IconButton icon={<CircleHelp size={14} />} label={t('aboutLoreClient')} onClick={() => onAction('about')} />
      </div>

      <div className="window-controls" aria-label={t('windowControls')}>
        <button type="button" aria-label={t('minimizeWindow')} onClick={() => void runWindowAction('minimize')}>
          <Minus size={15} />
        </button>
        <button
          type="button"
          aria-label={t('maximizeOrRestoreWindow')}
          onClick={() => void runWindowAction('maximize')}
        >
          <Maximize2 size={13} />
        </button>
        <button
          type="button"
          className="window-controls__close"
          aria-label={t('closeWindow')}
          onClick={() => void runWindowAction('close')}
        >
          <X size={15} />
        </button>
      </div>
    </header>
  )
}
