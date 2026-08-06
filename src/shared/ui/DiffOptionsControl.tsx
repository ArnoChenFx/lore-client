import { AlignJustify, Columns2, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useClientPreferences } from '../../hooks/useClientPreferences'
import { useDismissiblePopover } from '../../hooks/useDismissiblePopover'
import { CheckboxInput, NumberInput } from './ControlPrimitives'

/**
 * 工作区与 Revision Diff 共用的持久化选项。
 *
 * 控件直接订阅统一偏好服务，两个 Diff 面板始终使用同一组设置。上下文与空白规则
 * 会重新请求真实 Lore Diff；布局与展开全文只更新现有视图，避免无意义的远程重读。
 * 所有选项都写入同一份偏好，切换后立即生效并跨重启保留。
 */
export interface DiffOptionsControlProps {
  /**
   * 当前视图是否渲染文本 Diff（TextDiffView）。
   *
   * 布局与展开全文只对文本 Diff 有意义：真二进制、CSV/SVG 等专用资产预览与行内
   * 冲突视图都不是文本 Diff，调用方应在这些分支传 false 隐藏新增参数。
   */
  showTextLayoutOptions?: boolean
}

export function DiffOptionsControl({ showTextLayoutOptions = false }: DiffOptionsControlProps) {
  const { t } = useTranslation()
  const { preferences, update } = useClientPreferences()
  const [open, setOpen] = useState(false)
  const popoverRef = useDismissiblePopover<HTMLSpanElement>(open, () => setOpen(false))
  const options = preferences.diff
  const splitActive = options.diffStyle === 'split'

  const updateDiff = (patch: Partial<typeof options>) => {
    update({ diff: { ...options, ...patch } })
  }

  return (
    <span className="diff-options-control" ref={popoverRef}>
      <button
        type="button"
        className={
          open ||
          !preferences.binaryDiffVisible ||
          splitActive ||
          options.expandFullFile ||
          options.ignoreWhitespaceEol ||
          options.ignoreWhitespaceInline
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
          {showTextLayoutOptions && (
            <>
              <span className="tool-popover__heading" id="diff-layout-label">
                <strong>{t('diffStyleLayout')}</strong>
              </span>
              <span className="diff-options-control__layouts" role="radiogroup" aria-labelledby="diff-layout-label">
                <label className="diff-layout-option">
                  <input
                    type="radio"
                    name="diff-style"
                    value="unified"
                    checked={!splitActive}
                    onChange={() => updateDiff({ diffStyle: 'unified' })}
                  />
                  <AlignJustify aria-hidden="true" size={14} />
                  <span>
                    <strong>{t('diffStyleUnified')}</strong>
                    <small>{t('diffStyleUnifiedDescription')}</small>
                  </span>
                </label>
                <label className="diff-layout-option">
                  <input
                    type="radio"
                    name="diff-style"
                    value="split"
                    checked={splitActive}
                    onChange={() => updateDiff({ diffStyle: 'split' })}
                  />
                  <Columns2 aria-hidden="true" size={14} />
                  <span>
                    <strong>{t('diffStyleSplit')}</strong>
                    <small>{t('diffStyleSplitDescription')}</small>
                  </span>
                </label>
              </span>
              <span className="tool-popover__divider" />
              <label className="tool-check">
                <CheckboxInput
                  checked={options.expandFullFile}
                  onChange={(event) => updateDiff({ expandFullFile: event.target.checked })}
                />
                <span>
                  <strong>{t('expandFullFile')}</strong>
                  <small>{t('expandFullFileHint')}</small>
                </span>
              </label>
              <span className="tool-popover__divider" />
            </>
          )}
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
                updateDiff({
                  contextLines: Math.max(0, Math.min(100, Number(event.target.value) || 0))
                })
              }
            />
          </label>
          <span className="tool-popover__divider" />
          <label className="tool-check">
            <CheckboxInput
              checked={options.ignoreWhitespaceEol}
              onChange={(event) => updateDiff({ ignoreWhitespaceEol: event.target.checked })}
            />
            <span>{t('ignoreEndOfLineWhitespace')}</span>
          </label>
          <label className="tool-check">
            <CheckboxInput
              checked={options.ignoreWhitespaceInline}
              onChange={(event) => updateDiff({ ignoreWhitespaceInline: event.target.checked })}
            />
            <span>{t('ignoreInlineWhitespace')}</span>
          </label>
        </span>
      )}
    </span>
  )
}
