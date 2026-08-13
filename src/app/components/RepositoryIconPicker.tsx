import {
  BookOpen,
  Boxes,
  Code2,
  Cpu,
  Database,
  Film,
  FlaskConical,
  FolderGit2,
  Gamepad2,
  Globe2,
  Image as ImageIcon,
  Music2,
  Package,
  Palette,
  Rocket,
  Terminal,
  type LucideIcon
} from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { useDismissiblePopover } from '../../hooks/useDismissiblePopover'
import { DEFAULT_REPOSITORY_ICON_ID, REPOSITORY_ICON_IDS } from '../../shared/lib'
import { IconButton } from '../../shared/ui'
import type { RepositoryIconId } from '../../types'

const GRID_COLUMNS = 4

/** 图标组件只在渲染边界映射，偏好文件始终保存左侧的稳定语义 ID。 */
const REPOSITORY_ICON_COMPONENTS = {
  boxes: Boxes,
  'folder-git': FolderGit2,
  code: Code2,
  gamepad: Gamepad2,
  globe: Globe2,
  database: Database,
  package: Package,
  book: BookOpen,
  palette: Palette,
  image: ImageIcon,
  music: Music2,
  film: Film,
  flask: FlaskConical,
  cpu: Cpu,
  terminal: Terminal,
  rocket: Rocket
} satisfies Record<RepositoryIconId, LucideIcon>

/**
 * 图标选项没有可见名称或 Tooltip；稳定英文短名只作为 radiogroup 内的可访问名称，
 * 避免为纯图形选项维护一整套不会展示给用户的双语资源。
 */
const REPOSITORY_ICON_ACCESSIBLE_NAMES = {
  boxes: 'Default',
  'folder-git': 'Source',
  code: 'Code',
  gamepad: 'Game',
  globe: 'Web',
  database: 'Data',
  package: 'Package',
  book: 'Documentation',
  palette: 'Design',
  image: 'Image',
  music: 'Audio',
  film: 'Video',
  flask: 'Experiment',
  cpu: 'System',
  terminal: 'Tooling',
  rocket: 'Release'
} satisfies Record<RepositoryIconId, string>

interface RepositoryIconGlyphProps {
  icon: RepositoryIconId
  size?: number
}

/** 所有工作区图标统一经过此组件渲染，未知字符串无法进入组件映射。 */
export function RepositoryIconGlyph({ icon, size = 16 }: RepositoryIconGlyphProps) {
  const Glyph = REPOSITORY_ICON_COMPONENTS[icon]
  return <Glyph size={size} />
}

interface RepositoryIconPickerProps {
  repositoryName: string
  icon: RepositoryIconId
  onChange: (icon: RepositoryIconId | null) => void
}

/**
 * 工作区标题专用图标选择器。
 *
 * 浮层与入口同处一个控制区，统一关闭 Hook 才能正确区分内部点击和外部交互；
 * 方向键按四列网格移动，Home/End 直达首尾，选择后恢复入口焦点。
 */
export function RepositoryIconPicker({ repositoryName, icon, onChange }: RepositoryIconPickerProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const rootRef = useDismissiblePopover<HTMLDivElement>(open, () => setOpen(false))

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLButtonElement>('button[aria-checked="true"]')?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [open])

  const selectIcon = (nextIcon: RepositoryIconId) => {
    onChange(nextIcon === DEFAULT_REPOSITORY_ICON_ID ? null : nextIcon)
    setOpen(false)
    requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }))
  }

  const handleGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>('button[data-icon-id]') ?? [])
    if (buttons.length === 0) return

    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      buttons[event.key === 'Home' ? 0 : buttons.length - 1]?.focus()
      return
    }

    // 方向键增量表：event.key 是任意字符串，interface 的索引签名保持 open 字典
    // 语义，同时作为 named owner contract 通过 anti-slop no-known-value-widening。
    interface ArrowKeyDeltas {
      [key: string]: number | undefined
    }
    const deltas: ArrowKeyDeltas = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -GRID_COLUMNS,
      ArrowDown: GRID_COLUMNS
    }
    const delta = deltas[event.key]
    if (delta === undefined) return

    event.preventDefault()
    const currentIndex = Math.max(
      0,
      buttons.findIndex((button) => button === document.activeElement)
    )
    const nextIndex = (currentIndex + delta + buttons.length) % buttons.length
    buttons[nextIndex]?.focus()
  }

  return (
    <div ref={rootRef} className="sidebar__repo-icon-control">
      <IconButton
        ref={triggerRef}
        className="sidebar__repo-mark"
        data-repository-icon={icon}
        icon={<RepositoryIconGlyph icon={icon} />}
        label={t('changeWorkspaceIcon')}
        tooltip={false}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      />
      {open && (
        <div ref={panelRef} className="repository-icon-picker" role="dialog" aria-label={t('workspaceIcon')}>
          <div className="repository-icon-picker__heading">
            <strong>{t('workspaceIcon')}</strong>
            <small>{repositoryName}</small>
          </div>
          <div
            className="repository-icon-picker__grid"
            role="radiogroup"
            aria-label={t('chooseWorkspaceIcon')}
            onKeyDown={handleGridKeyDown}
          >
            {REPOSITORY_ICON_IDS.map((option) => {
              return (
                <IconButton
                  key={option}
                  className="repository-icon-picker__option"
                  data-icon-id={option}
                  role="radio"
                  aria-checked={icon === option}
                  icon={<RepositoryIconGlyph icon={option} size={17} />}
                  label={REPOSITORY_ICON_ACCESSIBLE_NAMES[option]}
                  tooltip={false}
                  onClick={() => selectIcon(option)}
                />
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
