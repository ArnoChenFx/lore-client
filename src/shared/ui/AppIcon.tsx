import appIconUrl from '../../../assets/app-icon-transparent.svg'

interface AppIconProps {
  className?: string
  /** 装饰场景默认不重复朗读；需要表达产品身份时传入可见替代文本。 */
  label?: string
}

/**
 * 前端统一使用的 Lore Client 软件图标。
 *
 * 前端使用与 Tauri 完整图标同源的透明背景 SVG，不在组件内重新绘制，也不让欢迎页
 * 和关于页各自选择临时 Lucide 图标。完整系统图标保留深色底座，前端透明版则让现有
 * 主题表面承担底色，避免浅色主题出现固定近黑品牌方块。
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
