import type { ChangeFile, Revision } from '../types'

/**
 * 以不可变方式切换单个演示文件的 Stage 状态。
 *
 * 该函数只服务不连接真实 Lore 后端的浏览器演示状态；真实仓库写入必须继续通过
 * `services/lore.ts` 与仓库写操作队列完成。
 */
export function toggleDemoFileStage(files: ChangeFile[], fileId: string) {
  return files.map((file) => (file.id === fileId ? { ...file, staged: !file.staged } : file))
}

/**
 * 批量设置演示文件的 Stage 状态，不修改调用方持有的原始数组或文件对象。
 */
export function setEveryDemoFileStaged(files: ChangeFile[], staged: boolean) {
  return files.map((file) => ({ ...file, staged }))
}

/**
 * 根据 Revision 稳定选取浏览器演示使用的 Inspector 文件集。
 *
 * 真实仓库的文件集合来自不可变 Revision Tree；这里的确定性投影仅用于纯前端预览，
 * 因而必须保持在 `demo` 边界内，避免被产品路径误当成后端数据。
 */
export function getDemoInspectorFiles(revision: Revision, files: ChangeFile[]) {
  if (files.length === 0) {
    return []
  }

  const count = 2 + (revision.shortId.charCodeAt(0) % files.length)
  return files.slice(0, Math.min(files.length, Math.max(2, count)))
}
