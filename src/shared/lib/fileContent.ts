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
 * 避免 Lore 为数百万行结构化资产生成完整文本补丁。CSV 是刻意保留的例外：其只读表格
 * 预览与行级文本 Diff 都有用户价值，且两条路径分别受既有限制约束。
 */
export function shouldLoadRepositoryTextDiff(file: RepositoryFileReference | null | undefined, path: string): boolean {
  if (!file || repositoryFileContentKind(file) === 'binary') return false
  const previewKind = binaryPreviewKind(path)
  return previewKind === null || previewKind === 'csv'
}
