import type { RepositoryIconId } from '../../types'

/** 既有 Boxes 图标仍是默认值；选择它等价于删除持久化图标覆盖。 */
export const DEFAULT_REPOSITORY_ICON_ID: RepositoryIconId = 'boxes'

/**
 * 图标 ID 的顺序同时定义选择面板的 4×4 空间布局。
 * 这里仅保存稳定语义，不依赖 React 或 Lucide，便于偏好规范化与测试复用。
 */
export const REPOSITORY_ICON_IDS = [
  'boxes',
  'folder-git',
  'code',
  'gamepad',
  'globe',
  'database',
  'package',
  'book',
  'palette',
  'image',
  'music',
  'film',
  'flask',
  'cpu',
  'terminal',
  'rocket'
] as const satisfies readonly RepositoryIconId[]

/** 拒绝手工编辑偏好文件注入的任意字符串，确保渲染层只消费已知图标。 */
export function isRepositoryIconId(value: unknown): value is RepositoryIconId {
  return typeof value === 'string' && (REPOSITORY_ICON_IDS as readonly string[]).includes(value)
}
