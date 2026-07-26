import type { RepositoryFileReference, RevisionFile } from '../../../types'

export type RevisionTreeRevealResult =
  | { kind: 'pending' }
  | { kind: 'missing'; path: string }
  | { kind: 'found'; selectedIds: string[]; primaryId: string }

/**
 * 把不同文件视图中的目录与文件名规范化为同一仓库相对路径。
 *
 * Lore 的根目录可能表示为 `.`、空字符串或带 `./` 前缀的路径；定位时统一去掉这些
 * 展示差异，同时把 Windows 分隔符转成 `/`，避免真实同一路径因 DTO 来源不同而失配。
 */
function repositoryRelativePath(file: RepositoryFileReference): string {
  const directory = file.path.replaceAll('\\', '/').replace(/^\.\/+|\/+$/g, '')
  return directory && directory !== '.' ? `${directory}/${file.name}` : file.name
}

/**
 * 解析“在文件树中显示”的目标。
 *
 * `treeReady=false` 明确表示完整不可变 Revision Tree 尚未完成惰性加载。此时必须保留
 * 请求，不能把暂时的空数组解释成“文件不存在”；只有树已就绪后才能给出 missing。
 */
export function resolveRevisionTreeReveal(
  treeReady: boolean,
  treeFiles: RevisionFile[],
  selectedFiles: RepositoryFileReference[],
  primaryFile: RepositoryFileReference
): RevisionTreeRevealResult {
  if (!treeReady) {
    return { kind: 'pending' }
  }

  const fileByPath = new Map(treeFiles.map((file) => [repositoryRelativePath(file), file] as const))
  const primaryPath = repositoryRelativePath(primaryFile)
  const primaryTreeFile = fileByPath.get(primaryPath)
  if (!primaryTreeFile) {
    return { kind: 'missing', path: primaryPath }
  }

  const selectedIds = selectedFiles
    .map((file) => fileByPath.get(repositoryRelativePath(file))?.id)
    .filter((id): id is string => Boolean(id))
  if (!selectedIds.includes(primaryTreeFile.id)) {
    selectedIds.push(primaryTreeFile.id)
  }

  return {
    kind: 'found',
    selectedIds: [...new Set(selectedIds)],
    primaryId: primaryTreeFile.id
  }
}
