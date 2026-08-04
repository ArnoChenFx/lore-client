import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  icon: ReactNode
  label: string
  badge?: string | number
  /** 少数纯图形选择面板会在外层提供完整语义，可显式关闭原生 title Tooltip。 */
  tooltip?: boolean
}

/**
 * 工具栏与紧凑面板共用的图标按钮。
 * 将可访问名称、禁用状态和徽标收敛到同一组件，避免纯图标按钮失去语义。
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, badge, tooltip = true, className = '', title = label, type = 'button', ...buttonProps },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`control-icon-button icon-button ${className}`.trim()}
      aria-label={label}
      title={tooltip ? title : undefined}
      {...buttonProps}
    >
      <span className="icon-button__glyph" aria-hidden="true">
        {icon}
      </span>
      {badge !== undefined && <span className="icon-button__badge">{badge}</span>}
    </button>
  )
})
