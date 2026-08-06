import type { ChangeFile, WorkingTreeDiff } from '../../types'
import { changeFilePath } from './changeTreeModel'

/**
 * 为浏览器演示模式生成可由 Diffs 库解析的示例补丁。
 *
 * 该数据只用于展示本地更改与 Revision Inspector 的布局、主题和补丁导出预览；
 * Tauri 模式仍只消费 Lore 返回的真实 Diff，演示模式也不会借此执行任何仓库写操作。
 */
export function createDemoWorkingTreeDiff(file: ChangeFile): WorkingTreeDiff {
  const path = changeFilePath(file)
  if (file.binary) {
    return { path, patch: '', action: file.status }
  }

  const previous =
    file.status === 'added'
      ? []
      : ['  "streamingBudget": 768,', '  "lightingProfile": "GoldenHour",', '  "enableReflections": false']
  const current =
    file.status === 'deleted'
      ? []
      : ['  "streamingBudget": 896,', '  "lightingProfile": "GoldenHourReview",', '  "enableReflections": true']

  return {
    path,
    action: file.status,
    patch: [
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -${previous.length === 0 ? 0 : 1},${previous.length} +${current.length === 0 ? 0 : 1},${current.length} @@`,
      ...previous.map((line) => `-${line}`),
      ...current.map((line) => `+${line}`)
    ].join('\n')
  }
}
