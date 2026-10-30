import appIconUrl from '../../../assets/app-icon.svg'

interface AppIconProps {
  className?: string
  /** 装饰场景默认不重复朗读；需要表达产品身份时传入可见替代文本。 */
  label?: string
}

/**
 * 前端统一使用的 Lore Client 软件图标。
 *
 * 与 Tauri 系统图标同源的 Lore 标志 SVG。
 */
export function AppIcon({ className, label }: AppIconProps) {
  return (
    <img
      className={className}
      src={appIconUrl}
      data-app-icon="true"
      alt={label ?? ''}
      aria-hidden={label ? undefined : 'true'}
      draggable="false"
    />
  )
}
