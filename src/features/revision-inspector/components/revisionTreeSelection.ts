import type { RevisionFile } from '../../../types'

export interface RevisionTreeSelectionState {
  selectedIds: string[]
  primaryId: string
  anchorId: string | null
}

/**
 * 当同一 Revision 的完整文件树发生刷新时，协调既有文件选区与最新文件集合。
 *
 * 惰性加载或后台刷新会暂时把文件集合投影为空数组；`treeReady=false` 时该空数组
 * 不代表文件已被删除，因此必须原样保留精确选区。只有完整树真正就绪后，才允许
 * 剔除已不存在的 ID，并在整个旧选区失效时回退到第一项。
 */
export function reconcileRevisionTreeSelection(
  treeReady: boolean,
  files: RevisionFile[],
  current: RevisionTreeSelectionState
): RevisionTreeSelectionState {
  if (!treeReady) {
    return current
  }

  const firstFileId = files[0]?.id ?? ''
  const availableIds = new Set(files.map((file) => file.id))
  const retained = current.selectedIds.filter((id) => availableIds.has(id))
  const primaryId = availableIds.has(current.primaryId) ? current.primaryId : firstFileId
  const anchorId = current.anchorId && availableIds.has(current.anchorId) ? current.anchorId : firstFileId || null

  return {
    selectedIds: retained.length > 0 ? retained : firstFileId ? [firstFileId] : [],
    primaryId,
    anchorId
  }
}
