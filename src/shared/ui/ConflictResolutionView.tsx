import type { MergeConflictResolution } from '@pierre/diffs'
import { UnresolvedFile, type FileContents } from '@pierre/diffs/react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import type { ResolvedTheme } from '../../types'
import { LORE_DIFF_DARK_THEME, LORE_DIFF_LIGHT_THEME } from '../lib'
import { TextButton } from './ControlPrimitives'

export interface ConflictResolutionResult {
  /** Diffs 生成解决内容时所基于的原始工作区正文。 */
  expectedContent: string
  /** 应写回工作区的解决后完整正文。 */
  resolvedContent: string
}

export interface ConflictResolutionViewProps {
  /** 带冲突标记的真实工作区文本内容。 */
  content: string
  /** 冲突文件名（用于语言识别与文件头展示）。 */
  fileName: string
  /** 当前应用的解析主题。 */
  themeType: ResolvedTheme
  /** 用户选择某个区域后给出读取时正文与解决后正文；调用方负责条件写回与刷新。 */
  onResolved: (result: ConflictResolutionResult) => void
}

const RESOLUTION_OPTIONS: Array<{ resolution: MergeConflictResolution; labelKey: string }> = [
  { resolution: 'current', labelKey: 'conflictAcceptCurrentChange' },
  { resolution: 'incoming', labelKey: 'conflictAcceptIncomingChange' },
  { resolution: 'both', labelKey: 'conflictAcceptBothChanges' }
]

/**
 * 行内冲突解决视图：把带标记的冲突内容交给 Diffs 库的 UnresolvedFile 渲染。
 *
 * React 封装会统一接管默认按钮的 onMergeConflictAction，因此这里通过官方扩展点
 * `renderMergeConflictUtility` 渲染当前语言的接受按钮；点击后调用实例的
 * `resolveConflict` 取得解决后的完整文件内容，由上层容器写回工作区并重新读取
 * 快照。组件不直接调用 Lore，避免把行内 UI 与写操作时序耦合。
 */
export function ConflictResolutionView({ content, fileName, themeType, onResolved }: ConflictResolutionViewProps) {
  const { t } = useTranslation()

  const file: FileContents = { name: fileName, contents: content }

  const renderActions = useCallback(
    (action: { conflictIndex: number }, getInstance: () => unknown) => {
      const instance = getInstance() as
        | {
            resolveConflict?: (
              index: number,
              resolution: MergeConflictResolution
            ) => { file?: FileContents } | undefined
          }
        | undefined
      return (
        <span className="conflict-resolution-actions">
          {RESOLUTION_OPTIONS.map(({ resolution, labelKey }) => (
            <TextButton
              key={resolution}
              onClick={() => {
                const result = instance?.resolveConflict?.(action.conflictIndex, resolution)
                if (result?.file) {
                  onResolved({ expectedContent: content, resolvedContent: result.file.contents })
                }
              }}
            >
              {t(labelKey as never)}
            </TextButton>
          ))}
        </span>
      )
    },
    [content, onResolved, t]
  )

  return (
    <UnresolvedFile
      file={file}
      options={{
        theme: {
          dark: LORE_DIFF_DARK_THEME,
          light: LORE_DIFF_LIGHT_THEME
        },
        themeType,
        mergeConflictActionsType: 'none'
      }}
      renderMergeConflictUtility={renderActions}
    />
  )
}
