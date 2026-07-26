import { ChevronDown } from 'lucide-react'
import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'

type ClassNameValue = string | false | null | undefined

/** 统一过滤可选类名，避免调用方为了附加布局类重复拼接基础控件类。 */
function joinClassNames(...values: ClassNameValue[]): string {
  return values.filter(Boolean).join(' ')
}

export interface ControlInputProps extends InputHTMLAttributes<HTMLInputElement> {}

/**
 * 所有紧凑输入框的底层入口。
 *
 * 该组件不持有值，也不改变浏览器原生校验；日期等非文本类型可以直接使用它。
 * `tool-input` 是迁移期兼容类，页面只应依赖新的 `control-input` 语义类。
 */
export const ControlInput = forwardRef<HTMLInputElement, ControlInputProps>(function ControlInput(
  { className, ...inputProps },
  ref
) {
  return <input ref={ref} className={joinClassNames('control-input', 'tool-input', className)} {...inputProps} />
})

export type TextInputProps = Omit<ControlInputProps, 'type'>

/** 明确固定为文本类型，避免表单上下文下出现不一致的浏览器默认推断。 */
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(inputProps, ref) {
  return <ControlInput ref={ref} type="text" {...inputProps} />
})

export type NumberInputProps = Omit<ControlInputProps, 'type'>

/** 数字输入统一使用等宽数字和紧凑宽度，同时保留 min、max、step 等原生能力。 */
export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  { className, ...inputProps },
  ref
) {
  return (
    <ControlInput
      ref={ref}
      type="number"
      className={joinClassNames('control-input--numeric', 'tool-input--numeric', className)}
      {...inputProps}
    />
  )
})

export type CheckboxInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>

/**
 * 统一复选框的原生语义与视觉入口。
 *
 * 组件继续使用原生 input，因此 checked、disabled、表单提交与读屏行为不会被重新实现；
 * 页面只负责通过外层 label 排列说明文字，不再按面板上下文重复绘制方框和勾选符号。
 */
export const CheckboxInput = forwardRef<HTMLInputElement, CheckboxInputProps>(function CheckboxInput(
  { className, ...inputProps },
  ref
) {
  return (
    <input
      ref={ref}
      type="checkbox"
      className={joinClassNames('control-checkbox', 'tool-checkbox', className)}
      {...inputProps}
    />
  )
})

export interface SelectInputProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** 只用于网格尺寸等外层布局；select 自身的附加类继续通过 className 传入。 */
  containerClassName?: string
  /** 密集工具栏可按需缩小箭头，但箭头始终不参与点击与可访问树。 */
  chevronSize?: number
  children: ReactNode
}

/**
 * 保留原生 select 的键盘、平台菜单与辅助功能，仅统一容器、箭头和状态样式。
 */
export const SelectInput = forwardRef<HTMLSelectElement, SelectInputProps>(function SelectInput(
  { children, className, containerClassName, chevronSize = 13, ...selectProps },
  ref
) {
  return (
    <span className={joinClassNames('control-select', 'tool-select', containerClassName)}>
      <select ref={ref} className={joinClassNames('control-select__input', className)} {...selectProps}>
        {children}
      </select>
      <ChevronDown aria-hidden="true" size={chevronSize} />
    </span>
  )
})

export type TextButtonVariant = 'neutral' | 'primary' | 'danger'

export interface TextButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: TextButtonVariant
}

/**
 * 普通文字操作按钮。
 *
 * 菜单项、树行、标签页和窗口控制拥有不同的键盘/布局契约，不应使用本组件。
 */
export const TextButton = forwardRef<HTMLButtonElement, TextButtonProps>(function TextButton(
  { className, type = 'button', variant = 'neutral', ...buttonProps },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={joinClassNames(
        'control-button',
        'tool-button',
        variant === 'primary' && 'is-primary',
        variant === 'danger' && 'is-danger',
        className
      )}
      {...buttonProps}
    />
  )
})
