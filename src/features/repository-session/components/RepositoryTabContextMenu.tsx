import { Check, Files, Pencil, RotateCcw, X, XCircle } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { REPOSITORY_TAB_COLOR_MATRIX } from '../../../shared/lib'
import type { RepositoryAccentColor } from '../../../shared/lib'
import type { ContextMenuPoint } from '../../../shared/ui'
import type { RepositoryTab } from './repositoryTabsModel'

export type RepositoryTabMenuRequest = { tab: RepositoryTab } & ContextMenuPoint

interface RepositoryTabContextMenuProps {
  request: RepositoryTabMenuRequest
  tabCount: number
  onClose: () => void
  onCloseTab: (sessionKey: string) => void
  onCloseOthers: (sessionKey: string) => void
  onCloseAll: () => void
  onRename: (sessionKey: string) => void
  onRestoreName: (repositoryPath: string) => void
  onColorChange: (repositoryPath: string, color: RepositoryAccentColor | null) => void
}

const VIEWPORT_GAP = 8
/**
 * 可访问颜色名称与色板使用完全相同的二维结构，避免再次按行列推断色相或明度。
 * 每个名称都描述一个独立类别色，屏幕阅读器和悬停提示能准确区分 25 个选项。
 */
const COLOR_LABEL_KEYS = [
  [
    'repositoryTabColorRed',
    'repositoryTabColorCoral',
    'repositoryTabColorOrange',
    'repositoryTabColorAmber',
    'repositoryTabColorBrown'
  ],
  [
    'repositoryTabColorGold',
    'repositoryTabColorOlive',
    'repositoryTabColorLime',
    'repositoryTabColorGreen',
    'repositoryTabColorEmerald'
  ],
  [
    'repositoryTabColorMint',
    'repositoryTabColorTeal',
    'repositoryTabColorCyan',
    'repositoryTabColorOcean',
    'repositoryTabColorSky'
  ],
  [
    'repositoryTabColorBlue',
    'repositoryTabColorCobalt',
    'repositoryTabColorNavy',
    'repositoryTabColorIndigo',
    'repositoryTabColorViolet'
  ],
  [
    'repositoryTabColorPurple',
    'repositoryTabColorPlum',
    'repositoryTabColorFuchsia',
    'repositoryTabColorPink',
    'repositoryTabColorRose'
  ]
] as const

/** 返回菜单内所有可操作项，颜色圆点与普通命令共享同一套方向键循环。 */
function menuItems(menu: HTMLElement | null): HTMLButtonElement[] {
  return Array.from(menu?.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]:not(:disabled)') ?? [])
}

/**
 * 项目 Tab 专用桌面上下文菜单。
 *
 * 菜单使用 Portal 脱离标签栏裁剪，测量后避让视口边缘；关闭时恢复右击锚点焦点。
 * 颜色只通过受控调色板写入 CSS 变量，绝不接受偏好文件中的任意样式值。
 */
export function RepositoryTabContextMenu({
  request,
  tabCount,
  onClose,
  onCloseTab,
  onCloseOthers,
  onCloseAll,
  onRename,
  onRestoreName,
  onColorChange
}: RepositoryTabContextMenuProps) {
  const { t } = useTranslation()
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: request.x, top: request.y, ready: false })
  const { tab } = request

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const bounds = menu.getBoundingClientRect()
    setPosition({
      left: Math.max(VIEWPORT_GAP, Math.min(request.x, window.innerWidth - bounds.width - VIEWPORT_GAP)),
      top: Math.max(VIEWPORT_GAP, Math.min(request.y, window.innerHeight - bounds.height - VIEWPORT_GAP)),
      ready: true
    })
  }, [request.x, request.y])

  useEffect(() => {
    const frame = requestAnimationFrame(() => menuItems(menuRef.current)[0]?.focus())
    return () => cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    const handleOutsidePointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose()
    }
    const handleOutsideContextMenu = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose()
    }
    const handleViewportChange = () => onClose()

    document.addEventListener('pointerdown', handleOutsidePointer, true)
    document.addEventListener('contextmenu', handleOutsideContextMenu, true)
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointer, true)
      document.removeEventListener('contextmenu', handleOutsideContextMenu, true)
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
      if (request.anchor.isConnected) request.anchor.focus({ preventScroll: true })
    }
  }, [onClose, request.anchor])

  const closeThen = (action: () => void) => {
    onClose()
    action()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault()
      onClose()
      return
    }
    const items = menuItems(menuRef.current)
    if (items.length === 0) return
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      items[event.key === 'Home' ? 0 : items.length - 1]?.focus()
      return
    }
    if (
      event.key !== 'ArrowDown' &&
      event.key !== 'ArrowUp' &&
      event.key !== 'ArrowLeft' &&
      event.key !== 'ArrowRight'
    ) {
      return
    }
    event.preventDefault()
    const current = items.findIndex((item) => item === document.activeElement)
    const delta = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1
    const next = current < 0 ? (delta > 0 ? 0 : items.length - 1) : (current + delta + items.length) % items.length
    items[next]?.focus()
  }

  return createPortal(
    <div
      ref={menuRef}
      className="revision-file-menu repository-tab-menu"
      role="menu"
      aria-label={t('status.repositoryTabContextActions', { name: tab.displayName })}
      onKeyDown={handleKeyDown}
      style={{ left: position.left, top: position.top, visibility: position.ready ? 'visible' : 'hidden' }}
    >
      <header>
        <strong title={tab.displayName}>{tab.displayName}</strong>
        <small title={tab.repository.path}>{tab.repository.path}</small>
      </header>
      <button type="button" role="menuitem" onClick={() => closeThen(() => onCloseTab(tab.sessionKey))}>
        <X size={15} />
        <span>{t('closeRepositoryTab')}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={tabCount <= 1}
        onClick={() => closeThen(() => onCloseOthers(tab.sessionKey))}
      >
        <Files size={15} />
        <span>{t('closeOtherRepositoryTabs')}</span>
      </button>
      <button type="button" role="menuitem" onClick={() => closeThen(onCloseAll)}>
        <XCircle size={15} />
        <span>{t('closeAllRepositoryTabs')}</span>
      </button>
      <hr />
      <button type="button" role="menuitem" onClick={() => closeThen(() => onRename(tab.sessionKey))}>
        <Pencil size={15} />
        <span>{t('renameRepositoryTab')}</span>
      </button>
      {tab.hasCustomName && (
        <button type="button" role="menuitem" onClick={() => closeThen(() => onRestoreName(tab.repository.path))}>
          <RotateCcw size={15} />
          <span>{t('restoreRepositoryTabName')}</span>
        </button>
      )}
      <hr />
      <div className="repository-tab-menu__color-group" role="group" aria-label={t('repositoryTabColor')}>
        <span>{t('repositoryTabColor')}</span>
        <div className="repository-tab-menu__color-grid">
          {REPOSITORY_TAB_COLOR_MATRIX.map((row, rowIndex) =>
            row.map((color, columnIndex) => {
              const colorLabel = t(COLOR_LABEL_KEYS[rowIndex][columnIndex])
              const selected = tab.hasCustomColor && tab.displayColor === color
              return (
                <button
                  key={color}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  aria-label={t('status.setRepositoryTabColor', { name: tab.displayName, color: colorLabel })}
                  title={colorLabel}
                  className="repository-tab-menu__color"
                  style={{ '--repo-color': color } as CSSProperties}
                  onClick={() => closeThen(() => onColorChange(tab.repository.path, color))}
                />
              )
            })
          )}
        </div>
      </div>
      <button
        type="button"
        role="menuitemradio"
        aria-checked={!tab.hasCustomColor}
        onClick={() => closeThen(() => onColorChange(tab.repository.path, null))}
      >
        <RotateCcw size={15} />
        <span>{t('automaticRepositoryTabColor')}</span>
        {!tab.hasCustomColor && <Check size={13} />}
      </button>
    </div>,
    document.body
  )
}
