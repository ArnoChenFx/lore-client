import { parsePatchFiles } from '@pierre/diffs'
import { FileDiff } from '@pierre/diffs/react'
import { useMemo } from 'react'

import type { ResolvedTheme } from '../../types'

export interface TextDiffViewProps {
  /** Lore 返回的完整 unified patch 文本；空串或解析失败时不渲染正文。 */
  patch: string
  /** 展示文件名；解析失败或空 patch 时仍可用于空态提示。 */
  filePath: string
  /** 当前应用的解析主题，Diffs 库按此切换 pierre-dark / pierre-light。 */
  themeType: ResolvedTheme
  /** 关闭库自带文件头，复用应用现有 Diff 面板标题栏。 */
  disableFileHeader?: boolean
  /** 默认沿用统一视图；组件保留切换能力供未来分栏入口复用。 */
  diffStyle?: 'unified' | 'split'
}

/**
 * 把 Lore 的 unified patch 交给 Diffs 库渲染的共享文本 Diff 视图。
 *
 * 组件只做一次 patch → FileDiffMetadata 的纯解析，并把主题、行号和文件头选项
 * 稳定传递给 `FileDiff`；渲染失败时返回 null，由调用方保留既有空态与错误文案，
 * 不会伪造成功。`FileDiffMetadata` 由 parsePatchFiles 每次重新生成，避免跨 Diff
 * 复用陈旧解析结果。
 */
export function TextDiffView({
  patch,
  filePath,
  themeType,
  disableFileHeader = true,
  diffStyle = 'unified'
}: TextDiffViewProps) {
  const fileDiff = useMemo(() => {
    if (!patch.trim()) return null
    try {
      return parsePatchFiles(patch)[0]?.files[0] ?? null
    } catch {
      return null
    }
  }, [patch])

  if (!fileDiff) return null

  return (
    <FileDiff
      fileDiff={fileDiff}
      options={{
        theme: {
          dark: 'pierre-dark',
          light: 'pierre-light'
        },
        themeType,
        diffStyle,
        disableFileHeader,
        disableLineNumbers: false,
        lineDiffType: 'word-alt'
      }}
    />
  )
}
