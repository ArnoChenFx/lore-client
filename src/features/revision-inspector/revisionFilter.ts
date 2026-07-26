import type { Revision } from '../../types'

/**
 * 在可见 Revision 列表中执行本地筛选。
 *
 * 真实后端可在历史规模较大时接管分页和搜索，但前端仍保留相同的查询语义。
 */
export function filterRevisions(revisions: Revision[], query: string) {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) {
    return revisions
  }

  return revisions.filter((revision) =>
    [revision.title, revision.author, revision.shortId, ...revision.branchPointers.map((pointer) => pointer.name)]
      .join(' ')
      .toLocaleLowerCase()
      .includes(normalized)
  )
}
