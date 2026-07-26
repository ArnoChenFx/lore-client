/**
 * 按对象标识移动列表项，并保持桌面标签拖放的方向语义。
 *
 * 目标索引使用移动前的数组位置：来源在目标左侧时，最终落在目标右侧；来源在
 * 目标右侧时，最终落在目标左侧。这样把标签拖到相邻标签上时等价于交换位置，
 * 把首项拖到末项上时也能真正移动到列表末尾。
 *
 * 无效操作必须复用原数组引用，避免项目会话持久化副作用为没有发生的排序重复
 * 写入 `client-preferences.json`。
 */
export function reorderItemsById<T>(items: T[], sourceId: string, targetId: string, readId: (item: T) => string): T[] {
  if (sourceId === targetId) {
    return items
  }

  const sourceIndex = items.findIndex((item) => readId(item) === sourceId)
  const targetIndex = items.findIndex((item) => readId(item) === targetId)
  if (sourceIndex < 0 || targetIndex < 0) {
    return items
  }

  const reordered = [...items]
  const [movedItem] = reordered.splice(sourceIndex, 1)
  if (movedItem === undefined) {
    return items
  }
  reordered.splice(targetIndex, 0, movedItem)
  return reordered
}
