import { DEFAULT_REPOSITORY_ICON_ID, isRepositoryAccentColor, isRepositoryIconId } from '../../../shared/lib'
import type { Repository, RepositoryIconId, RepositoryTabCustomization } from '../../../types'

/** 一个本地工作区 Tab；`sessionKey` 与可相同的 Lore Repository ID 明确分离。 */
export interface RepositoryTab {
  sessionKey: string
  repository: Repository
  displayName: string
  displayColor: string
  displayIcon: RepositoryIconId
  hasCustomName: boolean
  hasCustomColor: boolean
  hasCustomIcon: boolean
}

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

/** Windows 工作区路径按项目既有规则大小写不敏感比较，不改变实际展示路径。 */
function sameRepositoryPath(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase('en-US') === right.trim().toLocaleLowerCase('en-US')
}

/** 把仓库原始 DTO 与可选客户端覆盖合成为 Tab 专用展示数据。 */
export function resolveRepositoryTabPresentation(repository: Repository, customizations: RepositoryTabCustomization[]) {
  const customization = customizations.find((item) => sameRepositoryPath(item.repositoryPath, repository.path))
  const icon =
    isRepositoryIconId(customization?.icon) && customization.icon !== DEFAULT_REPOSITORY_ICON_ID
      ? customization.icon
      : undefined
  return {
    displayName: customization?.name || repository.name,
    displayColor: customization?.color || repository.color,
    displayIcon: icon || DEFAULT_REPOSITORY_ICON_ID,
    hasCustomName: Boolean(customization?.name),
    hasCustomColor: Boolean(customization?.color),
    hasCustomIcon: Boolean(icon)
  }
}

export interface RepositoryTabCustomizationPatch {
  /** null 表示恢复仓库默认名称；undefined 表示本次不修改名称。 */
  name?: string | null
  /** null 表示恢复路径哈希自动配色；undefined 表示本次不修改颜色。 */
  color?: string | null
  /** null 表示恢复既有 Boxes 图标；undefined 表示本次不修改图标。 */
  icon?: RepositoryIconId | null
}

/**
 * 更新单个 Tab 覆盖，并在两个字段都恢复默认后删除整个条目。
 *
 * 纯函数保留原列表中其他仓库的顺序；无实际变化时复用原数组，防止无意义偏好写盘。
 */
export function updateRepositoryTabCustomizations(
  customizations: RepositoryTabCustomization[],
  repository: Repository,
  patch: RepositoryTabCustomizationPatch
): RepositoryTabCustomization[] {
  const existingIndex = customizations.findIndex((item) => sameRepositoryPath(item.repositoryPath, repository.path))
  const existing = existingIndex >= 0 ? customizations[existingIndex] : undefined
  const requestedName = patch.name === undefined ? existing?.name : patch.name?.trim() || undefined
  const name = requestedName && requestedName !== repository.name ? requestedName.slice(0, 80) : undefined
  const requestedColor = patch.color === undefined ? existing?.color : patch.color || undefined
  const color =
    isRepositoryAccentColor(requestedColor) && requestedColor !== repository.color ? requestedColor : undefined
  const requestedIcon = patch.icon === undefined ? existing?.icon : patch.icon || undefined
  const icon =
    isRepositoryIconId(requestedIcon) && requestedIcon !== DEFAULT_REPOSITORY_ICON_ID ? requestedIcon : undefined
  const next =
    name || color || icon
      ? {
          repositoryPath: repository.path,
          ...(name ? { name } : undefined),
          ...(color ? { color } : undefined),
          ...(icon ? { icon } : undefined)
        }
      : null

  if (!existing && !next) return customizations
  const updated = [...customizations]
  if (existingIndex >= 0) {
    if (next) updated[existingIndex] = next
    else updated.splice(existingIndex, 1)
  } else if (next) {
    updated.push(next)
  }

  return JSON.stringify(updated) === JSON.stringify(customizations) ? customizations : updated
}
