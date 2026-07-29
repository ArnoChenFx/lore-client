import type { ChangeFile, RepositoryFileReference } from '../../types'

export type ChangeViewMode = 'flat' | 'tree'
export type ChangeTreeScope = 'unstaged' | 'staged' | 'revision'

export interface ChangeTreeRow {
  id: string
  kind: 'directory' | 'file'
  name: string
  path: string
  depth: number
  expanded?: boolean
  file?: ChangeFile
  descendantIds: string[]
}

export interface ChangeSelectionResult {
  selectedIds: string[]
  anchorId: string
}

export interface ChangeContextSelectionResult extends ChangeSelectionResult {
  primaryId: string
}

/** 文件路径发生变化时供各变更视图共享的精确展示语义。 */
export interface ChangePathTransition {
  sourcePath: string
  targetPath: string
  /** 同目录只改文件名属于重命名；父目录变化则属于移动。 */
  kind: 'moved' | 'renamed'
}

interface MutableDirectory {
  name: string
  path: string
  directories: Map<string, MutableDirectory>
  files: ChangeFile[]
}

const pathCollator = new Intl.Collator('zh-CN', {
  numeric: true,
  sensitivity: 'base'
})

/** 返回 Lore 使用的正斜杠仓库相对路径。 */
export function changeFilePath(file: RepositoryFileReference): string {
  return file.path === '.' ? file.name : `${file.path}/${file.name}`
}

/** 返回仓库相对路径的父目录；根目录文件统一使用 `.`。 */
function repositoryPathDirectory(path: string): string {
  const separatorIndex = path.lastIndexOf('/')
  return separatorIndex >= 0 ? path.slice(0, separatorIndex) || '.' : '.'
}

/**
 * 将 Lore 已确认的 Move 来源转换为稳定的移动/重命名展示模型。
 *
 * 这里刻意要求 `renamed` 状态和非空 `previousPath` 同时存在。新增、删除或来源缺失
 * 时不能根据文件名、大小或内容相似度猜测，否则同内容资产会被错误合并成一次移动。
 */
export function changeFilePathTransition(file: ChangeFile): ChangePathTransition | null {
  const sourcePath = file.previousPath?.replaceAll('\\', '/').trim()
  if (file.status !== 'renamed' || !sourcePath) return null

  const targetPath = changeFilePath(file)
  if (sourcePath === targetPath) return null

  return {
    sourcePath,
    targetPath,
    kind: repositoryPathDirectory(sourcePath) === repositoryPathDirectory(targetPath) ? 'renamed' : 'moved'
  }
}

/**
 * 展开文件写操作必须覆盖的全部仓库相对路径。
 *
 * 普通变更只包含当前路径；已经由 Lore 确认来源的移动/重命名同时包含旧、新路径，
 * 保证 Stage/Unstage 不会把一次原子路径变化拆成“删除尚未暂存、添加已经暂存”。
 */
export function changeFileOperationPaths(files: readonly ChangeFile[]): string[] {
  const paths = new Set<string>()
  for (const file of files) {
    const transition = changeFilePathTransition(file)
    if (transition) paths.add(transition.sourcePath)
    paths.add(changeFilePath(file))
  }
  return [...paths]
}

/** 文件和目录必须使用不同命名空间，才能保存彼此独立的视觉选区。 */
export function changeFileObjectId(fileId: string): string {
  return `file:${fileId}`
}

/** Stage 分区属于目录身份的一部分，避免同名路径在上下分区中互相高亮。 */
export function changeDirectoryObjectId(scope: ChangeTreeScope, path: string): string {
  return `directory:${scope}:${path}`
}

export function isChangeDirectoryObjectId(id: string): boolean {
  return id.startsWith('directory:')
}

/** 仅用于目录主选择的说明文案；路径自身即使包含冒号也会完整保留。 */
export function changeDirectoryPathFromObjectId(id: string): string | null {
  const match = id.match(/^directory:(?:unstaged|staged|revision):(.*)$/)
  return match?.[1] || null
}

/**
 * 把同一暂存分区的文件投影为可折叠树行。
 *
 * 折叠集合只影响目录子行是否输出，不改变文件 DTO 和选择集合，因此平铺/树视图
 * 切换、目录折叠或搜索变化都不会隐式丢失选择。
 */
export function buildChangeTreeRows(
  files: ChangeFile[],
  collapsedDirectories: ReadonlySet<string>,
  scope: ChangeTreeScope = 'unstaged'
): ChangeTreeRow[] {
  const root: MutableDirectory = {
    name: '',
    path: '',
    directories: new Map(),
    files: []
  }

  for (const file of files) {
    const directories = file.path === '.' ? [] : file.path.split('/').filter(Boolean)
    let current = root
    for (const segment of directories) {
      const path = current.path ? `${current.path}/${segment}` : segment
      let child = current.directories.get(segment)
      if (!child) {
        child = {
          name: segment,
          path,
          directories: new Map(),
          files: []
        }
        current.directories.set(segment, child)
      }
      current = child
    }
    current.files.push(file)
  }

  const collectDescendants = (directory: MutableDirectory): string[] => [
    ...directory.files.map((file) => file.id),
    ...[...directory.directories.values()].flatMap(collectDescendants)
  ]

  const rows: ChangeTreeRow[] = []
  const visit = (directory: MutableDirectory, depth: number) => {
    const directories = [...directory.directories.values()].sort((left, right) =>
      pathCollator.compare(left.name, right.name)
    )
    for (const child of directories) {
      const expanded = !collapsedDirectories.has(child.path)
      rows.push({
        id: changeDirectoryObjectId(scope, child.path),
        kind: 'directory',
        name: child.name,
        path: child.path,
        depth,
        expanded,
        descendantIds: collectDescendants(child)
      })
      if (expanded) {
        visit(child, depth + 1)
      }
    }

    const sortedFiles = [...directory.files].sort((left, right) => pathCollator.compare(left.name, right.name))
    for (const file of sortedFiles) {
      rows.push({
        id: changeFileObjectId(file.id),
        kind: 'file',
        name: file.name,
        path: changeFilePath(file),
        depth,
        file,
        descendantIds: [file.id]
      })
    }
  }

  visit(root, 0)
  return rows
}

/**
 * 返回一次仓库快照中仍然有效的全部选择对象。
 *
 * App 用它在刷新后清理已经消失或跨 Stage 移动的对象，避免留下不可见选区。
 */
export function collectChangeObjectIds(files: ChangeFile[]): string[] {
  const unstaged = files.filter((file) => !file.staged)
  const staged = files.filter((file) => file.staged)
  return [
    ...buildChangeTreeRows(unstaged, new Set(), 'unstaged'),
    ...buildChangeTreeRows(staged, new Set(), 'staged')
  ].map((row) => row.id)
}

/**
 * 把独立对象选区解析为 Lore 可以处理的真实文件集合。
 *
 * 文件对象直接加入结果，目录对象只在这里展开后代；最终按原文件顺序去重，
 * 因此同时选择父目录、子目录和零散文件也不会重复执行写操作。
 */
export function resolveSelectedChangeFiles(
  selectedObjectIds: readonly string[],
  files: ChangeFile[],
  allTreeRows: readonly ChangeTreeRow[]
): ChangeFile[] {
  const selected = new Set(selectedObjectIds)
  const resolvedFileIds = new Set<string>()
  for (const row of allTreeRows) {
    if (!selected.has(row.id)) continue
    if (row.kind === 'file' && row.file) {
      resolvedFileIds.add(row.file.id)
    } else {
      for (const descendantId of row.descendantIds) {
        resolvedFileIds.add(descendantId)
      }
    }
  }
  return files.filter((file) => resolvedFileIds.has(file.id))
}

/**
 * 限制 Stage 分割比例，使上下列表都保留最小高度。
 *
 * 容器低于两个最小高度之和时回退到 50%，避免计算出互相冲突的边界。
 */
export function clampStageSplitRatio(ratio: number, availableHeight: number, minimumPanelHeight = 96): number {
  if (!Number.isFinite(ratio) || !Number.isFinite(availableHeight) || availableHeight <= minimumPanelHeight * 2) {
    return 0.5
  }
  const minimumRatio = minimumPanelHeight / availableHeight
  return Math.min(1 - minimumRatio, Math.max(minimumRatio, ratio))
}

/**
 * 计算桌面式文件选择。
 *
 * 普通点击替换选区，Ctrl/Cmd 点击增减单项，Shift 点击从锚点建立连续范围。
 * 返回独立数组，调用方可以安全写入 React 状态而不修改原集合。
 */
export function selectChangeFile(
  orderedIds: string[],
  selectedIds: readonly string[],
  clickedId: string,
  anchorId: string | null,
  options: { toggle: boolean; range: boolean }
): ChangeSelectionResult {
  if (options.range && anchorId) {
    const anchorIndex = orderedIds.indexOf(anchorId)
    const clickedIndex = orderedIds.indexOf(clickedId)
    if (anchorIndex >= 0 && clickedIndex >= 0) {
      const [start, end] = anchorIndex <= clickedIndex ? [anchorIndex, clickedIndex] : [clickedIndex, anchorIndex]
      const rangeIds = orderedIds.slice(start, end + 1)
      return {
        selectedIds: options.toggle ? [...new Set([...selectedIds, ...rangeIds])] : rangeIds,
        anchorId
      }
    }
  }

  if (options.toggle) {
    const next = new Set(selectedIds)
    if (next.has(clickedId)) {
      next.delete(clickedId)
    } else {
      next.add(clickedId)
    }
    return { selectedIds: [...next], anchorId: clickedId }
  }

  return { selectedIds: [clickedId], anchorId: clickedId }
}

/**
 * 计算右击对象后的上下文选区。
 *
 * 右击现有多选中的对象需要保留整组批量上下文，但右击对象本身必须成为主要项和
 * 后续 Shift 选择的锚点。若对象原本不在选区中，则按桌面列表语义改为单选该对象。
 */
export function selectChangeContext(selectedIds: readonly string[], contextId: string): ChangeContextSelectionResult {
  return {
    selectedIds: selectedIds.includes(contextId) ? [...selectedIds] : [contextId],
    primaryId: contextId,
    anchorId: contextId
  }
}
