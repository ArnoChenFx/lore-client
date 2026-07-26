import type { ChangeFile, WorkingTreeDiff } from '../../types'
import { changeFilePath } from './changeTreeModel'

/**
 * 浏览器演示只用于验证 Diff 布局；真实模式始终通过 Lore 服务读取文件差异。
 *
 * 该夹具同时服务本地更改与 Revision Inspector，集中后可避免两个领域生成不同的
 * 演示补丁语义。
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
  const oldCount = Math.max(1, previous.length)
  const newCount = Math.max(1, current.length)
  return {
    path,
    action: file.status,
    patch: [
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -1,${oldCount} +1,${newCount} @@`,
      ...previous.map((line) => `-${line}`),
      ...current.map((line) => `+${line}`)
    ].join('\n')
  }
}
