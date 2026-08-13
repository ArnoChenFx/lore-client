import type { MergeConflictResolution } from '@pierre/diffs'
import { UnresolvedFile, type FileContents } from '@pierre/diffs/react'
import { preloadUnresolvedFile } from '@pierre/diffs/ssr'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { ResolvedTheme } from '../../types'
import { createDiffsLocalization, LORE_DIFF_DARK_THEME, LORE_DIFF_LIGHT_THEME } from '../lib'
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

/** Diffs 冲突 action 中用于安全切片的稳定最小投影。 */
export interface ConflictRegionAction {
  conflictIndex: number
  hunkIndex: number
  startContentIndex: number
  endContentIndex: number
  endMarkerContentIndex: number
  conflict: {
    conflictIndex: number
    startLineIndex: number
    startLineNumber: number
    baseMarkerLineIndex?: number
    baseMarkerLineNumber?: number
    separatorLineIndex: number
    separatorLineNumber: number
    endLineIndex: number
    endLineNumber: number
  }
  markerLines: {
    start: string
    base?: string
    separator: string
    end: string
  }
}

type PreparedConflictResolution = Awaited<ReturnType<typeof preloadUnresolvedFile>>

export interface NormalizedLoreConflictContent {
  /** 可交给 Diffs 解析的正文。 */
  contents: string
  /** 因 Lore 粘连标记而补入换行后，该标记所在的零基行号。 */
  syntheticMarkerLineIndices: ReadonlySet<number>
}

/**
 * 把 Lore 在“某一侧原文没有结尾换行”时粘到正文末尾的冲突标记恢复为独立行。
 *
 * Diffs 只把行首的七字符标记识别为冲突结构；Lore 当前可能生成
 * `local text||||||| original`、`base=======` 或 `incoming>>>>>>> theirs`。这里仅在
 * 保留标记前补换行，不修改普通短序列，也不改写传给 Rust 乐观并发校验的原始正文。
 */
export function normalizeLoreConflictContent(content: string): NormalizedLoreConflictContent {
  const markerPattern = /([^\r\n])((?:<{7,}|>{7,}|\|{7,})(?=[\t ]|\r?\n|$)|={7,}(?=\r?\n|$))/g
  const syntheticMarkerLineIndices = new Set<number>()
  let contents = ''
  let sourceIndex = 0
  let newlineCount = 0

  /** 统一累计输出和 LF 数量；Diffs 同样只按 LF 推进零基行号。 */
  const append = (value: string) => {
    contents += value
    for (let index = value.indexOf('\n'); index >= 0; index = value.indexOf('\n', index + 1)) {
      newlineCount += 1
    }
  }

  for (const match of content.matchAll(markerPattern)) {
    const matchIndex = match.index
    const contentBeforeMarkerEnd = matchIndex + match[1].length
    append(content.slice(sourceIndex, contentBeforeMarkerEnd))
    append('\n')
    // 补入 LF 后，下一个行号正好等于累计 LF 数；记录它以便解决时移除合成换行。
    syntheticMarkerLineIndices.add(newlineCount)
    append(match[2])
    sourceIndex = matchIndex + match[0].length
  }
  append(content.slice(sourceIndex))

  return { contents, syntheticMarkerLineIndices }
}

/** 只需要解析正文的兼容入口；解决写回必须同时消费上面的合成换行元数据。 */
export function normalizeLoreConflictMarkerBoundaries(content: string): string {
  return normalizeLoreConflictContent(content).contents
}

/**
 * 使用 Diffs 自己的解析器预检冲突正文，并把所有解析异常收敛为稳定结果。
 *
 * Lore Status 与工作区文件读取不是同一个原子快照：外部编辑器可能在两者之间改写
 * 冲突标记。预检必须复用最终渲染器的解析规则，避免自建简化计数器错误放行嵌套、
 * diff3 基线段或第三方库不支持的边界组合。
 */
export async function prepareConflictResolution(
  file: FileContents,
  options: Parameters<typeof preloadUnresolvedFile>[0]['options']
): Promise<{ status: 'ready'; value: PreparedConflictResolution } | { status: 'invalid' }> {
  try {
    const normalizedFile = { ...file, contents: normalizeLoreConflictMarkerBoundaries(file.contents) }
    return { status: 'ready', value: await preloadUnresolvedFile({ file: normalizedFile, options }) }
  } catch {
    return { status: 'invalid' }
  }
}

/**
 * 根据 Diffs 已解析出的冲突区域，在经过预检的真实文件上生成解决后正文。
 *
 * Diffs React 包装层以受控模式创建底层实例，却没有把原始 `file` 放入实例缓存；
 * 直接调用 `instance.resolveConflict()` 会用缺失的 previousFile 重建文件并返回空正文。
 * 这里仅消费公开 action 中的原始行坐标，并严格验证索引、顺序与四类标记，任何
 * 不一致都拒绝产生结果，避免第三方实例状态再次演变成破坏性写回。
 */
export function resolvePreparedConflict(
  file: FileContents,
  action: ConflictRegionAction,
  resolution: MergeConflictResolution,
  syntheticMarkerLineIndices: ReadonlySet<number> = new Set()
): FileContents | undefined {
  // 与 Diffs 的 SPLIT_WITH_NEWLINES 保持同一分行语义，确保 action 的零基行索引可直接使用。
  const lines = file.contents === '' ? [] : file.contents.split(/(?<=\n)/)
  const { startLineIndex, baseMarkerLineIndex, separatorLineIndex, endLineIndex } = action.conflict
  const currentEndLineIndex = baseMarkerLineIndex ?? separatorLineIndex

  const indicesAreValid =
    Number.isInteger(startLineIndex) &&
    Number.isInteger(separatorLineIndex) &&
    Number.isInteger(endLineIndex) &&
    startLineIndex >= 0 &&
    startLineIndex < currentEndLineIndex &&
    currentEndLineIndex <= separatorLineIndex &&
    separatorLineIndex < endLineIndex &&
    endLineIndex < lines.length &&
    (baseMarkerLineIndex === undefined ||
      (Number.isInteger(baseMarkerLineIndex) &&
        startLineIndex < baseMarkerLineIndex &&
        baseMarkerLineIndex < separatorLineIndex))
  if (!indicesAreValid) return undefined

  const markerLinesAreValid =
    lines[startLineIndex] === action.markerLines.start &&
    lines[separatorLineIndex] === action.markerLines.separator &&
    lines[endLineIndex] === action.markerLines.end &&
    (baseMarkerLineIndex === undefined
      ? action.markerLines.base === undefined
      : lines[baseMarkerLineIndex] === action.markerLines.base)
  if (!markerLinesAreValid) return undefined

  /** 只移除规范化阶段明确补入的 LF；真实 LF/CRLF 绝不能被通用 trim 改写。 */
  const removeSyntheticEnding = (sourceLines: string[], boundaryMarkerLineIndex: number): string[] => {
    if (!syntheticMarkerLineIndices.has(boundaryMarkerLineIndex) || sourceLines.length === 0) return sourceLines
    const result = [...sourceLines]
    const lastIndex = result.length - 1
    const lastLine = result[lastIndex]
    if (!lastLine.endsWith('\n')) return sourceLines
    result[lastIndex] = lastLine.slice(0, -1)
    return result
  }

  const beforeLines = removeSyntheticEnding(lines.slice(0, startLineIndex), startLineIndex)
  const currentLines = removeSyntheticEnding(lines.slice(startLineIndex + 1, currentEndLineIndex), currentEndLineIndex)
  const incomingLines = removeSyntheticEnding(lines.slice(separatorLineIndex + 1, endLineIndex), endLineIndex)
  const selectedLines =
    resolution === 'current'
      ? currentLines
      : resolution === 'incoming'
        ? incomingLines
        : [...currentLines, ...incomingLines]

  return {
    ...file,
    contents: [...beforeLines, ...selectedLines, ...lines.slice(endLineIndex + 1)].join('')
  }
}

/**
 * 行内冲突解决视图：把带标记的冲突内容交给 Diffs 库的 UnresolvedFile 渲染。
 *
 * React 封装会统一接管默认按钮的 onMergeConflictAction，因此这里通过官方扩展点
 * `renderMergeConflictUtility` 渲染当前语言的接受按钮；点击后使用已预检正文和
 * Diffs action 的精确区域生成完整文件，由上层容器写回工作区并重新读取快照。
 * 组件不直接调用 Lore，避免把行内 UI 与写操作时序耦合。
 */
export function ConflictResolutionView({ content, fileName, themeType, onResolved }: ConflictResolutionViewProps) {
  const { i18n, t } = useTranslation()
  const language = i18n.resolvedLanguage
  const file = useMemo<FileContents>(() => ({ name: fileName, contents: content }), [content, fileName])
  const normalizedConflict = useMemo(() => normalizeLoreConflictContent(content), [content])
  const diffsLocalization = useMemo(
    () =>
      createDiffsLocalization({
        // 显式绑定本次渲染语言，避免 Diffs 的长生命周期回调在切换语言后保留旧文案。
        unmodifiedLines: (count) => t('status.diffUnmodifiedLines', { count, lng: language }),
        moreUnchangedContext: t('diffMoreUnchangedContext', { lng: language }),
        expandAll: t('diffExpandAll', { lng: language }),
        noNewlineAtEnd: t('diffNoNewlineAtEnd', { lng: language }),
        currentChangeMarker: t('diffCurrentChangeMarker', { lng: language }),
        incomingChangeMarker: t('diffIncomingChangeMarker', { lng: language }),
        acceptCurrentChange: t('conflictAcceptCurrentChange', { lng: language }),
        acceptIncomingChange: t('conflictAcceptIncomingChange', { lng: language }),
        acceptBothChanges: t('conflictAcceptBothChanges', { lng: language })
      }),
    [language, t]
  )
  const options = useMemo(
    () => ({
      ...diffsLocalization,
      theme: {
        dark: LORE_DIFF_DARK_THEME,
        light: LORE_DIFF_LIGHT_THEME
      },
      themeType,
      mergeConflictActionsType: 'none' as const
    }),
    [diffsLocalization, themeType]
  )
  const [prepared, setPrepared] = useState<
    | { file: FileContents; status: 'ready'; value: PreparedConflictResolution }
    | { file: FileContents; status: 'invalid' }
    | null
  >(null)

  useEffect(() => {
    let active = true
    void prepareConflictResolution(file, options).then((result) => {
      if (active) setPrepared({ file, ...result })
    })
    return () => {
      // 文件切换后丢弃旧预检结果，避免把上一个冲突文件的合法性套到新正文上；
      // 渲染期通过 prepared.file 与当前 file 的引用比较过滤过期结果。
      active = false
    }
  }, [file, options])

  const renderActions = useCallback(
    (action: ConflictRegionAction) => (
      <span className="conflict-resolution-actions">
        {RESOLUTION_OPTIONS.map(({ resolution, labelKey }) => (
          <TextButton
            key={resolution}
            onClick={() => {
              const resolvedFile = resolvePreparedConflict(
                { ...file, contents: normalizedConflict.contents },
                action,
                resolution,
                normalizedConflict.syntheticMarkerLineIndices
              )
              if (resolvedFile) {
                onResolved({ expectedContent: content, resolvedContent: resolvedFile.contents })
              }
            }}
          >
            {t(labelKey as never)}
          </TextButton>
        ))}
      </span>
    ),
    [content, file, normalizedConflict, onResolved, t]
  )

  if (prepared?.file !== file) {
    return (
      <div className="working-diff__empty" aria-busy="true">
        <strong>{t('conflictContentChecking')}</strong>
      </div>
    )
  }

  if (prepared.status === 'invalid') {
    return (
      <div className="working-diff__empty is-error" role="alert">
        <strong>{t('conflictContentInvalid')}</strong>
        <span>{t('conflictContentInvalidHint')}</span>
      </div>
    )
  }

  return (
    <UnresolvedFile
      file={prepared.value.file}
      options={options}
      prerenderedHTML={prepared.value.prerenderedHTML}
      renderMergeConflictUtility={renderActions}
    />
  )
}
