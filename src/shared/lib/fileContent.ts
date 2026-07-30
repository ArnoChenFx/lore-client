import type { FileContentKind, RepositoryFileReference, WorkingTreeDiff } from '../../types'
import { binaryPreviewKind } from './binaryPreview'

/**
 * 返回文件当前最可靠的内容分类。
 *
 * 真实后端结果始终优先使用结构化三态；`binary` 只兼容尚未迁移的演示数据和测试夹具，
 * 不得在这里重新引入路径或扩展名推断。
 */
export function repositoryFileContentKind(file: RepositoryFileReference | null | undefined): FileContentKind {
  if (!file) return 'unknown'
  if (file.contentClassification) return file.contentClassification.kind
  if (file.binary === true) return 'binary'
  if (file.binary === false) return 'text'
  return 'unknown'
}

/** Lore Diff 已加载时，其正文 marker 比列表阶段分类更权威。 */
export function resolvedDiffContentKind(
  file: RepositoryFileReference | null | undefined,
  diff: WorkingTreeDiff | null | undefined
): FileContentKind {
  return diff?.contentClassification?.kind ?? repositoryFileContentKind(file)
}

/** 兼容旧调用方的布尔查询；`unknown` 不会被武断地当作二进制。 */
export function isBinaryRepositoryFile(file: RepositoryFileReference | null | undefined): boolean {
  return repositoryFileContentKind(file) === 'binary'
}

/**
 * 判断文件是否应进入可能生成完整补丁的文本 Diff 路径。
 *
 * 通用内容分类回答“这些字节是否像文本”，专用预览白名单回答“产品应如何安全展示”。
 * OBJ、GLTF 等格式即使正文是 UTF-8，也必须优先走有大小限制、可取消解析的资产预览，
 * 避免 Lore 为数百万行结构化资产生成完整文本补丁。CSV 与 SVG 是刻意保留的例外：
 * 启用二进制 Diff 时走专用表格或安全栅格图片预览，关闭后才请求行级文本 Diff。
 */
export function shouldLoadRepositoryTextDiff(
  file: RepositoryFileReference | null | undefined,
  path: string,
  binaryDiffVisible: boolean
): boolean {
  if (!file || repositoryFileContentKind(file) === 'binary') return false
  const previewKind = binaryPreviewKind(path)
  return previewKind === null || (isTextBackedPreviewPath(path) && !binaryDiffVisible)
}

/**
 * 判断当前文件是否应进入受限预览路径。
 *
 * 真二进制内容无论开关状态都保留在该路径：关闭时仍需读取轻量大小摘要。只有已确认
 * 为文本的 CSV/SVG 会在关闭开关后完全退出预览路径，避免无意义的元数据请求遮住文本 Diff。
 */
export function shouldUseRepositoryPreview(
  file: RepositoryFileReference | null | undefined,
  path: string,
  binaryDiffVisible: boolean,
  resolvedKind: FileContentKind = repositoryFileContentKind(file)
): boolean {
  if (!file) return false
  if (resolvedKind === 'binary') return true
  if (!binaryPreviewKind(path)) return false
  return !isTextBackedPreviewPath(path) || binaryDiffVisible
}

/** CSV/SVG 的源文件是文本，产品允许在专用预览与文本 Diff 之间切换。 */
function isTextBackedPreviewPath(path: string): boolean {
  const normalized = path.split(/[?#]/, 1)[0]?.replaceAll('\\', '/') ?? ''
  const extension = normalized.split('/').at(-1)?.split('.').at(-1)?.toLocaleLowerCase()
  return extension === 'csv' || extension === 'svg'
}
