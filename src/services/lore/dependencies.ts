/** 文件依赖关系的增删查，以及依赖图的收集与加载。 */
import type {
  OperationContext,
  LoreDependencyGraphEdge,
  LoreDependencyGraphNode,
  LoreDependencyGraphQuery,
  LoreDependencyQuery,
  LoreDependencySelection,
  LoreEvent,
  LoreOperationResult
} from '../../types'
import { createOperationContext, withOperationRequest } from '../operationRequests'
import { runOperation } from './core'
import { readNumber, readString } from './utils'

/** 为文件增加一条依赖边，默认由 Lore 执行循环检测。 */
export async function addFileDependency(
  repositoryPath: string,
  sourcePath: string,
  dependencyPath: string,
  tags: string[],
  force = false,
  operationContext?: OperationContext
): Promise<LoreOperationResult> {
  return runOperation(
    'lore_file_dependency_add',
    {
      repositoryPath,
      sourcePath,
      dependencyPath,
      tags,
      force
    },
    operationContext
  )
}

/** 移除一条精确依赖边；传入的标签决定移除范围。 */
export async function removeFileDependency(
  repositoryPath: string,
  sourcePath: string,
  dependencyPath: string,
  tags: string[],
  operationContext?: OperationContext
): Promise<LoreOperationResult> {
  return runOperation(
    'lore_file_dependency_remove',
    {
      repositoryPath,
      sourcePath,
      dependencyPath,
      tags
    },
    operationContext
  )
}

/** 查询当前或指定不可变 Revision 的依赖关系。 */
export async function listFileDependencies(
  repositoryPath: string,
  paths: string[],
  options: LoreDependencySelection,
  reverse = false,
  revision?: string,
  operationContext?: OperationContext
): Promise<LoreDependencyQuery> {
  const result = await runOperation(
    'lore_file_dependency_list',
    {
      repositoryPath,
      paths,
      revision: revision?.trim() || null,
      recursive: options.recursive,
      reverse,
      tags: options.tags,
      depthLimit: options.depthLimit
    },
    operationContext
  )
  return parseFileDependencies(result.events, reverse, options.recursive, options.depthLimit)
}

/** 依靠 ListFile/Entry/FileEnd 事件边界恢复稳定的按根文件分组结构。 */
export function parseFileDependencies(
  events: LoreEvent[],
  reverse: boolean,
  recursive: boolean,
  depthLimit: number
): LoreDependencyQuery {
  const groups: LoreDependencyQuery['groups'] = []
  let current: LoreDependencyQuery['groups'][number] | null = null
  for (const event of events) {
    if (event.tagName === 'fileDependencyListFile') {
      current = { path: readString(event.data.path, ''), entries: [] }
      if (current.path) groups.push(current)
      continue
    }
    if (event.tagName === 'fileDependencyListFileEnd') {
      current = null
      continue
    }
    if (event.tagName !== 'fileDependencyListEntry' || !current) continue
    const path = readString(event.data.path, '')
    if (!path) continue
    current.entries.push({
      path,
      tags: Array.isArray(event.data.tags) ? event.data.tags.map((tag) => readString(tag)).filter(Boolean) : [],
      depth: readNumber(event.data.depth)
    })
  }
  return { groups, reverse, recursive, depthLimit }
}

const FILE_DEPENDENCY_GRAPH_NODE_LIMIT = 240

type DirectDependencyBatchLoader = (paths: string[]) => Promise<LoreDependencyQuery>

/**
 * 从固定 Lore 版本的直连查询构建精确文件依赖图。
 *
 * 上游递归 List 会把传递项的深度统一简化为 1，并丢失传递边标签，因此这里按 BFS
 * 层批量查询 `recursive = false` 的直连关系。访问集合既防止循环导致无界请求，也
 * 让同一文件最多进入一个批次；节点上限用于保护大型仓库和 Tauri IPC。
 */
export async function collectFileDependencyGraph(
  rootPaths: string[],
  options: LoreDependencySelection,
  reverse: boolean,
  revision: string,
  loadDirectBatch: DirectDependencyBatchLoader,
  nodeLimit = FILE_DEPENDENCY_GRAPH_NODE_LIMIT
): Promise<LoreDependencyGraphQuery> {
  const normalizedRoots = [...new Set(rootPaths.map((path) => path.trim()).filter(Boolean))]
  const safeNodeLimit = Math.max(1, Math.floor(nodeLimit))
  const acceptedRoots = normalizedRoots.slice(0, safeNodeLimit)
  const rootSet = new Set(acceptedRoots)
  const distances = new Map(acceptedRoots.map((path) => [path, 0]))
  const expanded = new Set<string>()
  const groups: LoreDependencyQuery['groups'] = []
  const edges = new Map<string, LoreDependencyGraphEdge>()
  let frontier = acceptedRoots
  let frontierDistance = 0
  let truncated = acceptedRoots.length < normalizedRoots.length

  while (frontier.length > 0) {
    if (options.recursive && options.depthLimit > 0 && frontierDistance >= options.depthLimit) break

    const batchPaths = frontier.filter((path) => !expanded.has(path))
    if (batchPaths.length === 0) break
    batchPaths.forEach((path) => expanded.add(path))

    const batch = await loadDirectBatch(batchPaths)
    const nextFrontier: string[] = []
    for (const group of batch.groups) {
      const groupDistance = distances.get(group.path) ?? frontierDistance
      const acceptedEntries: typeof group.entries = []

      for (const entry of group.entries) {
        const existingDistance = distances.get(entry.path)
        if (existingDistance === undefined) {
          if (distances.size >= safeNodeLimit) {
            truncated = true
            continue
          }
          distances.set(entry.path, groupDistance + 1)
          nextFrontier.push(entry.path)
        } else if (groupDistance + 1 < existingDistance) {
          distances.set(entry.path, groupDistance + 1)
        }

        acceptedEntries.push({ ...entry, depth: 0 })
        const sourcePath = reverse ? entry.path : group.path
        const dependencyPath = reverse ? group.path : entry.path
        const edgeKey = `${sourcePath}\u0000${dependencyPath}`
        const existingEdge = edges.get(edgeKey)
        edges.set(edgeKey, {
          sourcePath,
          dependencyPath,
          // 同一批次理论上只有一条边；合并标签可容忍上游重复事件而不丢信息。
          tags: [...new Set([...(existingEdge?.tags ?? []), ...entry.tags])].sort()
        })
      }

      groups.push({ path: group.path, entries: acceptedEntries })
    }

    if (!options.recursive) break
    frontier = [...new Set(nextFrontier)].filter((path) => !expanded.has(path))
    frontierDistance += 1
  }

  const nodes: LoreDependencyGraphNode[] = [...distances.entries()]
    .map(([path, distance]) => ({ path, distance, root: rootSet.has(path) }))
    .sort((left, right) => left.distance - right.distance || left.path.localeCompare(right.path))

  return {
    revision,
    groups,
    nodes,
    edges: [...edges.values()].sort(
      (left, right) =>
        left.sourcePath.localeCompare(right.sourcePath) || left.dependencyPath.localeCompare(right.dependencyPath)
    ),
    reverse,
    recursive: options.recursive,
    depthLimit: options.depthLimit,
    truncated,
    nodeLimit: safeNodeLimit
  }
}

/**
 * 在同一不可变 Revision 上加载可视化所需的精确边。
 *
 * 该函数复用现有 Tauri List 命令；每个 BFS 层只发起一次批量读取，不把人类可读
 * CLI 输出当作数据源。图节点达到上限后停止扩张并返回 truncated 标记。
 */
export async function loadFileDependencyGraph(
  repositoryPath: string,
  rootPaths: string[],
  options: LoreDependencySelection,
  reverse = false,
  revision = '',
  operationContext?: OperationContext
): Promise<LoreDependencyGraphQuery> {
  return withOperationRequest(operationContext ?? createOperationContext(repositoryPath), async (requestContext) => {
    return collectFileDependencyGraph(rootPaths, options, reverse, revision, (paths) =>
      listFileDependencies(
        repositoryPath,
        paths,
        {
          rootFiles: paths,
          tags: options.tags,
          recursive: false,
          // 非递归查询不会消费深度，但显式传 1 可以准确表达“只读直连边”的意图。
          depthLimit: 1
        },
        reverse,
        revision,
        requestContext
      )
    )
  })
}
