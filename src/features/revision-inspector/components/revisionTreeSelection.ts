import type { RevisionFile } from '../../../types'

export interface RevisionTreeSelectionState {
  selectedIds: string[]
  primaryId: string
  anchorId: string | null
}

/** Revision 上下文切换后使用空选区，避免文件树替用户选择首项并触发自动滚动。 */
export function createEmptyRevisionTreeSelection(): RevisionTreeSelectionState {
  return {
    selectedIds: [],
    primaryId: '',
    anchorId: null
  }
}

/**
 * 只有显式的主要选区才能驱动“定位到工作区”等文件级操作。
 * 不回退到首个文件，确保空选区不会被工具栏重新解释成隐式默认选择。
 */
export function findRevisionTreePrimaryFile(files: RevisionFile[], primaryId: string): RevisionFile | undefined {
  if (!primaryId) {
    return undefined
  }
  return files.find((file) => file.id === primaryId)
}

/**
 * 当同一 Revision 的完整文件树发生刷新时，协调既有文件选区与最新文件集合。
 *
 * 惰性加载或后台刷新会暂时把文件集合投影为空数组；`treeReady=false` 时该空数组
 * 不代表文件已被删除，因此必须原样保留精确选区。只有完整树真正就绪后，才允许
 * 剔除已不存在的 ID。整个旧选区失效时保持空选区，只有用户点击或显式定位操作
 * 才能重新建立主要文件，避免后台刷新触发意外的选中与滚动。
 */
export function reconcileRevisionTreeSelection(
  treeReady: boolean,
  files: RevisionFile[],
  current: RevisionTreeSelectionState
): RevisionTreeSelectionState {
  if (!treeReady) {
    return current
  }

  const availableIds = new Set(files.map((file) => file.id))
  const retained = current.selectedIds.filter((id) => availableIds.has(id))
  const primaryId = retained.includes(current.primaryId) ? current.primaryId : (retained[0] ?? '')
  const anchorId = current.anchorId && retained.includes(current.anchorId) ? current.anchorId : primaryId || null

  return {
    selectedIds: retained,
    primaryId,
    anchorId
  }
}
