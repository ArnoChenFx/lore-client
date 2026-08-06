import { parsePatchFiles, type FileDiffLoadedFiles } from '@pierre/diffs'
import { FileDiff } from '@pierre/diffs/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { ResolvedTheme } from '../../types'
import { LORE_DIFF_DARK_THEME, LORE_DIFF_LIGHT_THEME, readErrorMessage } from '../lib'

/**
 * 全文加载器所需的最小目标描述，来自 Diffs 库解析后的当前 diff。
 *
 * Lore 返回的 patch 没有 diff --git 头，Diffs 库对 modified、added、deleted
 * 与 renamed 一律解析为 rename-changed（部分 diff）；调用方应结合自己的
 * ChangeFile 状态判断哪一侧不存在，把不存在的侧返回为空内容文件，而不是让
 * type 决定是否读取。
 */
export interface TextDiffFullFileTarget {
  /** 当前（新）文件路径。 */
  name: string
  /** rename/move 时的旧路径；非 rename 不存在。 */
  prevName?: string
  /** 变化类型；`rename-pure` 时旧侧没有内容，应返回 `oldFile: null`。 */
  type: 'change' | 'rename-pure' | 'rename-changed' | 'new' | 'deleted'
}

/**
 * 展开全文时由调用方提供的真实文件加载器。
 *
 * 参数是 Diffs 库解析后的目标 diff，返回前后完整文本内容；库会把部分 patch
 * 水合为完整文件后再展开所有未变化行。`oldFile` 为 `null` 表示该侧不存在
 * （纯重命名），`newFile` 始终存在。传入的 `name` / `prevName` 已由
 * normalizePatchPath 清洗为真实仓库路径：去掉 `a/`、`b/` 前缀与 Lore 统一
 * Diff 标签的 `@<revision>` 后缀。
 */
export type TextDiffFullFileLoader = (fileDiff: TextDiffFullFileTarget) => Promise<FileDiffLoadedFiles>

/**
 * 把 Diffs 库解析 patch 头部得到的路径归一化为真实仓库路径。
 *
 * 需要同时处理两类非路径内容：
 * 1. 没有 `diff --git` 头的 Lore patch 会被库解析为 rename-changed，`name` 与
 *    `prevName` 因而携带 `b/`、`a/` 前缀（演示与标准 git 风格 patch 也如此）；
 *    这些前缀不是真实仓库路径，直接交给 Rust 读取会得到“文件不存在”。
 * 2. Lore 上游统一 Diff 标签使用 `path@<revision_number>` 格式（见上游
 *    `lore-revision/src/file/diff.rs` 的 `diff_label`），解析器会原样保留 `@`
 *    后的 Revision 序号；它同样不是路径的一部分，必须先剥掉再读取文件，
 *    否则 Rust 会报“the file … does not exist in revision …”。
 *
 * 只剥第一个路径段，真实目录就叫 `a` / `b` 的文件不受影响（它们的前缀会
 * 保留在更靠后的路径段）；`@` 后缀只匹配末尾的纯数字 Revision 序号，名字
 * 本身以数字结尾且带 `@` 的极端情况不在支持范围。
 */
export function normalizePatchPath(path: string): string {
  return path
    .replaceAll('\\', '/')
    .replace(/^[ab]\//, '')
    .replace(/@\d+$/, '')
}

export interface TextDiffViewProps {
  /** Lore 返回的完整 unified patch 文本；空串或解析失败时不渲染正文。 */
  patch: string
  /** 展示文件名；解析失败或空 patch 时仍可用于空态提示。 */
  filePath: string
  /** 当前应用的解析主题，Diffs 库按此切换 pierre-dark / pierre-light。 */
  themeType: ResolvedTheme
  /** 关闭库自带文件头，复用应用现有 Diff 面板标题栏。 */
  disableFileHeader?: boolean
  /** Diff 布局：统一视图（默认）或左右分栏；两种布局都支持展开全文。 */
  diffStyle?: 'unified' | 'split'
  /** 展开全文：按需读取真实前后文件内容并显示所有未变化行；unified 与 split 均可用。 */
  expandFullFile?: boolean
  /**
   * 展开全文时按需读取真实前后文件内容的加载器；未提供时 Diffs 库只展开 patch
   * 范围内的上下文，不会伪造完整文件。
   */
  loadDiffFiles?: TextDiffFullFileLoader
}

/**
 * 把 Lore 的 unified patch 交给 Diffs 库渲染的共享文本 Diff 视图。
 *
 * 组件只做一次 patch → FileDiffMetadata 的纯解析，并把主题、行号、布局与全文
 * 展开选项稳定传递给 `FileDiff`；渲染失败时返回 null，由调用方保留既有空态与
 * 错误文案，不会伪造成功。`FileDiffMetadata` 由 parsePatchFiles 每次重新生成，
 * 避免跨 Diff 复用陈旧解析结果。
 *
 * 展开全文依赖 Diffs 库的 `loadDiffFiles` 水合路径：加载器读取真实前后文件后，
 * 部分 patch 被补全为完整文件，`expandUnchanged` 再显示所有未变化行。加载失败
 * 时视图保持部分状态，并在上方显示原因提示，不把失败伪装成全文。
 */
export function TextDiffView({
  patch,
  filePath,
  themeType,
  disableFileHeader = true,
  diffStyle = 'unified',
  expandFullFile = false,
  loadDiffFiles
}: TextDiffViewProps) {
  const { t } = useTranslation()
  // 只用对象引用表达当前视图身份，避免错误状态额外持有整份 patch 文本副本。
  const fullFileIdentity = useMemo<object>(
    () => ({ filePath, expandFullFile, patchLength: patch.length }),
    [expandFullFile, filePath, patch]
  )
  const [fullFileError, setFullFileError] = useState<{ identity: object; message: string } | null>(null)
  const fullFileRequestCounter = useRef(0)
  const fileDiff = useMemo(() => {
    if (!patch.trim()) return null
    try {
      return parsePatchFiles(patch)[0]?.files[0] ?? null
    } catch {
      return null
    }
  }, [patch])

  /** 文件、补丁或展开策略变化时，立即淘汰旧加载请求及其错误提示。 */
  useEffect(() => {
    fullFileRequestCounter.current += 1
    setFullFileError(null)
    return () => {
      // 卸载或身份变化时同步使在途请求失效，避免异步拒绝写回已离开的视图。
      fullFileRequestCounter.current += 1
    }
  }, [expandFullFile, filePath, loadDiffFiles, patch])

  /**
   * 包装调用方的全文加载器：把读取失败翻译为可见提示后继续抛给 Diffs 库，库内部
   * 会捕获并保持部分视图；重复调用同一文件不会产生额外请求（库按 fileDiff 去重）。
   */
  const resolveFullFiles = useCallback(
    async (target: TextDiffFullFileTarget) => {
      if (!loadDiffFiles) throw new Error('Missing full-file loader')
      const requestId = fullFileRequestCounter.current + 1
      fullFileRequestCounter.current = requestId
      try {
        setFullFileError(null)
        // 库解析出的路径可能带 a/、b/ 前缀与 Lore 的 @<revision> 标签后缀；
        // 传给调用方加载器前清洗为真实仓库路径。
        return await loadDiffFiles({
          ...target,
          name: normalizePatchPath(target.name),
          prevName: target.prevName ? normalizePatchPath(target.prevName) : undefined
        })
      } catch (error) {
        // 文件切换或更新的 loader 已经开始后，旧请求不能把错误写回新视图。
        if (requestId === fullFileRequestCounter.current) {
          setFullFileError({ identity: fullFileIdentity, message: readErrorMessage(error) })
        }
        throw error
      }
    },
    [fullFileIdentity, loadDiffFiles]
  )

  if (!fileDiff) return null

  return (
    <div className="text-diff-view">
      {fullFileError?.identity === fullFileIdentity && (
        <div className="text-diff-view__full-file-error" role="alert">
          <strong>{t('expandFullFileFailed')}</strong>
          <span>{fullFileError.message}</span>
        </div>
      )}
      <FileDiff
        fileDiff={fileDiff}
        options={{
          theme: {
            dark: LORE_DIFF_DARK_THEME,
            light: LORE_DIFF_LIGHT_THEME
          },
          themeType,
          diffStyle,
          disableFileHeader,
          disableLineNumbers: false,
          lineDiffType: 'word-alt',
          // Diffs 库只接受 line-info / line-info-basic / simple / metadata / custom；
          // line-info 在 hunk 折叠处显示未变化行数并提供展开入口，符合展开全文交互。
          hunkSeparators: 'simple',
          expandUnchanged: expandFullFile,
          overflow: 'wrap',
          /*
           * 未提供真实加载器（如浏览器演示模式）时不传 loader，Diffs 库只展开
           * patch 范围内的上下文，避免把“缺少数据源”渲染成全文加载失败。
           */
          loadDiffFiles: expandFullFile && loadDiffFiles ? resolveFullFiles : undefined
        }}
      />
    </div>
  )
}
