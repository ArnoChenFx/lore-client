import type { ChangeFile } from '../../types'

export interface RevisionDiffBaselineResult {
  sourceRevision: string | null
  changes: ChangeFile[]
}

/**
 * 为多父 Revision 选择默认差异基线。
 *
 * 第一父仍然是正常的历史比较方向；只有它没有任何文件变化时，才回退到首个
 * 非空父节点。这样既保留普通合并的第一父语义，又避免把相对另一父节点有实际
 * 内容变化的合并 Revision 误显示成“没有差异”。
 */
export function chooseRevisionDiffBaseline(
  candidates: readonly RevisionDiffBaselineResult[]
): RevisionDiffBaselineResult {
  return (
    candidates.find((candidate) => candidate.changes.length > 0) ??
    candidates[0] ?? {
      sourceRevision: null,
      changes: []
    }
  )
}

/**
 * 读取一个 Revision 相对所有候选父节点的轻量清单，并选择默认比较基线。
 *
 * Loader 由调用边界注入，使纯状态测试能够覆盖真实的“读取每个父节点后选择”
 * 调度语义，同时不让本模块依赖 Tauri IPC。
 */
export async function loadRevisionDiffBaseline(
  parentIds: readonly string[],
  loadChanges: (sourceRevision: string | null) => Promise<ChangeFile[]>
): Promise<RevisionDiffBaselineResult> {
  const sourceRevisions: Array<string | null> = parentIds.length > 0 ? [...parentIds] : [null]
  const candidates: RevisionDiffBaselineResult[] = []
  /*
   * 每个父节点都要枚举两棵不可变树。合并 Revision 的父节点数量通常很少，顺序读取
   * 不影响最终语义，却避免多个完整树清单在 Rust 与 WebView 中同时达到峰值。
   */
  for (const sourceRevision of sourceRevisions) {
    candidates.push({
      sourceRevision,
      changes: await loadChanges(sourceRevision)
    })
  }
  return chooseRevisionDiffBaseline(candidates)
}
