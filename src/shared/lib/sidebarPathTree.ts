import type { Branch, LoreTag } from '../../types'

/**
 * 固定使用英文排序规则，避免切换界面语言或操作系统区域设置后列表顺序漂移。
 * 主比较忽略大小写；当两个名称在英文规则下等价时，再按原始字符稳定区分。
 */
const ENGLISH_NAME_COLLATOR = new Intl.Collator('en-US', {
  sensitivity: 'base'
})

export function compareEnglishNames(left: string, right: string): number {
  const primaryOrder = ENGLISH_NAME_COLLATOR.compare(left, right)
  if (primaryOrder !== 0) return primaryOrder
  return left < right ? -1 : left > right ? 1 : 0
}

export interface SidebarPathTreeLeaf<T> {
  kind: 'item'
  /** 树行只显示当前层的最后一段；完整名称始终保留在原始 DTO 中。 */
  name: string
  id: string
  item: T
}

export interface SidebarPathTreeFolder<T> {
  kind: 'folder'
  name: string
  /** 从树根开始的稳定完整路径，用于区分不同层级的同名目录。 */
  path: string
  children: SidebarPathTreeNode<T>[]
}

export type SidebarPathTreeNode<T> = SidebarPathTreeFolder<T> | SidebarPathTreeLeaf<T>
export type SidebarBranchTreeNode = SidebarPathTreeNode<Branch>
export type SidebarTagTreeNode = SidebarPathTreeNode<LoreTag>

interface MutablePathFolder<T> {
  name: string
  path: string
  folders: Map<string, MutablePathFolder<T>>
  leaves: SidebarPathTreeLeaf<T>[]
}

function createMutableFolder<T>(name: string, path: string): MutablePathFolder<T> {
  return {
    name,
    path,
    folders: new Map(),
    leaves: []
  }
}

/**
 * 把可安全解释的斜杠名称拆成路径段。
 *
 * Lore DTO 保留真实名称；若遇到前导、尾随或连续斜杠，前端不擅自清洗或合并空段，
 * 而是把整个名称作为普通叶子显示，保证菜单动作仍指向原始 Lore 对象。
 */
function splitObjectPath(name: string): string[] {
  const segments = name.split('/')
  return segments.length > 1 && segments.every(Boolean) ? segments : [name]
}

function finalizeFolder<T>(folder: MutablePathFolder<T>): SidebarPathTreeNode<T>[] {
  const folders: SidebarPathTreeFolder<T>[] = [...folder.folders.values()]
    .sort((left, right) => compareEnglishNames(left.name, right.name))
    .map((child) => ({
      kind: 'folder',
      name: child.name,
      path: child.path,
      children: finalizeFolder(child)
    }))

  const leaves = [...folder.leaves].sort((left, right) => {
    const nameOrder = compareEnglishNames(left.name, right.name)
    return nameOrder || compareEnglishNames(left.id, right.id)
  })

  // 文件夹和真实对象分开排序后再拼接，明确保证每一层都是“目录优先”。
  return [...folders, ...leaves]
}

/**
 * 将同一 Lore 对象类型下的命名对象投影成纯展示树。
 *
 * 本函数不会复制或改写 DTO；叶子持有原对象引用，因此选择、定位和右键菜单始终消费
 * 精确对象。`feat` 与 `feat/axx` 可以同时存在：前者成为根叶子，后者进入同名目录，
 * 最终由“目录优先”规则稳定排列。
 */
export function buildSidebarPathTree<T>(
  items: T[],
  getName: (item: T) => string,
  getId: (item: T) => string
): SidebarPathTreeNode<T>[] {
  const root = createMutableFolder<T>('', '')

  for (const item of items) {
    const fullName = getName(item)
    const segments = splitObjectPath(fullName)
    let parent = root

    for (const segment of segments.slice(0, -1)) {
      const path = parent.path ? `${parent.path}/${segment}` : segment
      let folder = parent.folders.get(segment)
      if (!folder) {
        folder = createMutableFolder(segment, path)
        parent.folders.set(segment, folder)
      }
      parent = folder
    }

    parent.leaves.push({
      kind: 'item',
      name: segments.at(-1) ?? fullName,
      id: getId(item),
      item
    })
  }

  return finalizeFolder(root)
}

/**
 * 按树的可见预序把 DTO 展平：先输出当前层的文件夹内容，再输出当前层叶子。
 * 主视图虽然不绘制目录行，但借此与侧栏保持完全相同的逐层排序语义。
 */
function flattenPathTree<T>(nodes: SidebarPathTreeNode<T>[], result: T[] = []): T[] {
  for (const node of nodes) {
    if (node.kind === 'folder') {
      flattenPathTree(node.children, result)
    } else {
      result.push(node.item)
    }
  }
  return result
}

export function sortPathItemsByEnglishName<T>(
  items: T[],
  getName: (item: T) => string,
  getId: (item: T) => string
): T[] {
  return flattenPathTree(buildSidebarPathTree(items, getName, getId))
}

export function sortBranchesByEnglishName(branches: Branch[]): Branch[] {
  return sortPathItemsByEnglishName(
    branches,
    (branch) => branch.name,
    (branch) => branch.id
  )
}

export function sortTagsByEnglishName(tags: LoreTag[]): LoreTag[] {
  return sortPathItemsByEnglishName(
    tags,
    (tag) => tag.name,
    (tag) => tag.id
  )
}

export function buildSidebarBranchTree(branches: Branch[]): SidebarBranchTreeNode[] {
  return buildSidebarPathTree(
    branches,
    (branch) => branch.name,
    (branch) => branch.id
  )
}

export function buildSidebarTagTree(tags: LoreTag[]): SidebarTagTreeNode[] {
  return buildSidebarPathTree(
    tags,
    (tag) => tag.name,
    (tag) => tag.id
  )
}
