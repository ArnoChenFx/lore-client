import { SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useClientPreferences } from '../../hooks/useClientPreferences'
import { useDismissiblePopover } from '../../hooks/useDismissiblePopover'
import { CheckboxInput, NumberInput } from './ControlPrimitives'

/**
 * 工作区与 Revision Diff 共用的持久化选项。
 *
 * 控件直接订阅统一偏好服务，两个 Diff 面板始终使用同一组设置；App 的读取 effect
 * 同样依赖这份偏好，因此修改后会重新请求真实 Lore Diff，而不是只在前端隐藏行。
 */
export function DiffOptionsControl() {
  const { t } = useTranslation()
  const { preferences, update } = useClientPreferences()
  const [open, setOpen] = useState(false)
  const popoverRef = useDismissiblePopover<HTMLSpanElement>(open, () => setOpen(false))
  const options = preferences.diff

  return (
    <span className="diff-options-control" ref={popoverRef}>
      <button
        type="button"
        className={
          open || !preferences.binaryDiffVisible || options.ignoreWhitespaceEol || options.ignoreWhitespaceInline
            ? 'is-active'
            : ''
        }
        aria-label={t('diffOptions')}
        aria-expanded={open}
        title={t('diffOptions')}
        onClick={() => setOpen((value) => !value)}
      >
        <SlidersHorizontal size={13} />
      </button>
      {open && (
        <span className="diff-options-control__popover">
          <span className="tool-popover__heading">
            <SlidersHorizontal size={13} />
            <strong>{t('diffOptions')}</strong>
          </span>
          <label className="tool-check">
            <CheckboxInput
              checked={preferences.binaryDiffVisible}
              onChange={(event) =>
                update({
                  binaryDiffVisible: event.target.checked
                })
              }
            />
            <span>{t('showBinaryDiff')}</span>
          </label>
          <span className="tool-popover__divider" />
          <label className="tool-field tool-field--horizontal">
            <span>{t('diffContextLines')}</span>
            <NumberInput
              min={0}
              max={100}
              value={options.contextLines}
              onChange={(event) =>
                update({
                  diff: {
                    ...options,
                    contextLines: Math.max(0, Math.min(100, Number(event.target.value) || 0))
                  }
                })
              }
            />
          </label>
          <span className="tool-popover__divider" />
          <label className="tool-check">
            <CheckboxInput
              checked={options.ignoreWhitespaceEol}
              onChange={(event) =>
                update({
                  diff: {
                    ...options,
                    ignoreWhitespaceEol: event.target.checked
                  }
                })
              }
            />
            <span>{t('ignoreEndOfLineWhitespace')}</span>
          </label>
          <label className="tool-check">
            <CheckboxInput
              checked={options.ignoreWhitespaceInline}
              onChange={(event) =>
                update({
                  diff: {
                    ...options,
                    ignoreWhitespaceInline: event.target.checked
                  }
                })
              }
            />
            <span>{t('ignoreInlineWhitespace')}</span>
          </label>
        </span>
      )}
    </span>
  )
}
