/**
 * Lore 移动/重命名补丁头的来源路径提取。
 *
 * 固定 Lore 版本的移动事件（`fileDiff` / `LoreFileDiffEventData`）只携带
 * `path` / `patch` / `action` 三个字段，没有独立的来源路径字段；真实来源路径由
 * 上游 `emit_move_diff` 写进补丁头的 `move from <来源路径>` 行，紧随其后的
 * `move to <目标路径>` 行重复了事件本身的 `path`。
 *
 * 因此任何需要“旧路径”的调用方都必须从补丁文本读取，不能假设存在结构化字段：
 * 读一个不存在的键只会恒得空值，而把来源当作缺失会进一步让界面把一次移动
 * 显示成“删除 + 新增”。
 */

/** 补丁头里来源路径行的前缀，与上游 `emit_move_diff` 完全一致。 */
const MOVE_FROM_PREFIX = 'move from '

/**
 * 从统一 Diff 文本中提取移动来源路径。
 *
 * 只接受位于标准 diff 头之前、`move from ` 开头的行，避免把正文里恰好包含该
 * 前缀的内容误判为来源路径。返回值统一使用 `/` 分隔符，与 Lore 仓库相对路径
 * 的其余展示保持一致。
 */
export function readMoveSourceFromPatch(patch: string): string | undefined {
  if (!patch) return undefined
  for (const line of patch.split('\n')) {
    // 头部结束后正文可能包含任意内容，见到 `diff --git` 或首个 hunk 即停止扫描。
    if (line.startsWith('diff --git ') || line.startsWith('@@')) break
    if (line.startsWith(MOVE_FROM_PREFIX)) {
      const source = line.slice(MOVE_FROM_PREFIX.length).trim()
      return source ? source.replaceAll('\\', '/') : undefined
    }
  }
  return undefined
}
