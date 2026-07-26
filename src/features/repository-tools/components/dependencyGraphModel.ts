import type { LoreDependencyGraphEdge, LoreDependencyGraphNode, LoreDependencyGraphQuery } from '../../../types'

export interface DependencyGraphLayoutNode extends LoreDependencyGraphNode {
  x: number
  y: number
  width: number
  height: number
}

export interface DependencyGraphLayoutEdge extends LoreDependencyGraphEdge {
  id: string
  path: string
  labelX: number
  labelY: number
}

export interface DependencyGraphLayout {
  width: number
  height: number
  nodes: DependencyGraphLayoutNode[]
  edges: DependencyGraphLayoutEdge[]
}

/**
 * 计算缩放后应使用的平移偏移，使鼠标指向的图坐标在视口中的位置保持不变。
 *
 * 画布同时使用 CSS translate 与 scale。两套坐标不能直接相加：先从旧变换还原
 * 图坐标，再投影到新缩放比例，才能避免滚轮缩放时内容跳离鼠标。
 */
export function dependencyGraphPanOffsetAfterZoom(
  panOffset: number,
  pointerOffset: number,
  currentZoom: number,
  nextZoom: number
): number {
  if (currentZoom <= 0 || nextZoom <= 0) return panOffset
  const graphCoordinate = (pointerOffset - panOffset) / currentZoom
  return pointerOffset - graphCoordinate * nextZoom
}

const NODE_WIDTH = 196
const NODE_HEIGHT = 48
const COLUMN_GAP = 76
const ROW_GAP = 14
const CANVAS_PADDING = 24

/**
 * 生成确定性的分层布局。
 *
 * 正向查询把根文件放在左侧；反向查询把根文件放在右侧，使真实
 * `source → dependency` 箭头在两种模式下都尽量保持从左向右。循环或跨层回边
 * 会自动从节点另一侧绕行，不依赖随机力导向布局，因此测试和截图不会漂移。
 */
export function layoutDependencyGraph(query: LoreDependencyGraphQuery): DependencyGraphLayout {
  if (query.nodes.length === 0) {
    return { width: 0, height: 0, nodes: [], edges: [] }
  }

  const maxDistance = Math.max(...query.nodes.map((node) => node.distance), 0)
  const columns = new Map<number, LoreDependencyGraphNode[]>()
  for (const node of query.nodes) {
    const column = query.reverse ? maxDistance - node.distance : node.distance
    const bucket = columns.get(column) ?? []
    bucket.push(node)
    columns.set(column, bucket)
  }

  for (const bucket of columns.values()) {
    bucket.sort((left, right) => {
      if (left.root !== right.root) return left.root ? -1 : 1
      return left.path.localeCompare(right.path)
    })
  }

  const widestColumnCount = Math.max(...[...columns.values()].map((bucket) => bucket.length), 1)
  const canvasHeight =
    CANVAS_PADDING * 2 + widestColumnCount * NODE_HEIGHT + Math.max(0, widestColumnCount - 1) * ROW_GAP
  const canvasWidth = CANVAS_PADDING * 2 + (maxDistance + 1) * NODE_WIDTH + maxDistance * COLUMN_GAP
  const nodes: DependencyGraphLayoutNode[] = []

  for (const [column, bucket] of columns) {
    const columnHeight = bucket.length * NODE_HEIGHT + Math.max(0, bucket.length - 1) * ROW_GAP
    const offsetY = CANVAS_PADDING + Math.max(0, (canvasHeight - CANVAS_PADDING * 2 - columnHeight) / 2)
    bucket.forEach((node, row) => {
      nodes.push({
        ...node,
        x: CANVAS_PADDING + column * (NODE_WIDTH + COLUMN_GAP),
        y: offsetY + row * (NODE_HEIGHT + ROW_GAP),
        width: NODE_WIDTH,
        height: NODE_HEIGHT
      })
    })
  }

  const nodeByPath = new Map(nodes.map((node) => [node.path, node]))
  const edges = query.edges.flatMap<DependencyGraphLayoutEdge>((edge, index) => {
    const source = nodeByPath.get(edge.sourcePath)
    const dependency = nodeByPath.get(edge.dependencyPath)
    if (!source || !dependency) return []

    const forward = dependency.x >= source.x
    const startX = forward ? source.x + source.width : source.x
    const endX = forward ? dependency.x : dependency.x + dependency.width
    const startY = source.y + source.height / 2
    const endY = dependency.y + dependency.height / 2
    const bend = Math.max(34, Math.abs(endX - startX) * 0.46)
    const firstControlX = startX + (forward ? bend : -bend)
    const secondControlX = endX - (forward ? bend : -bend)

    return [
      {
        ...edge,
        id: `${edge.sourcePath}\u0000${edge.dependencyPath}\u0000${edge.tags.join('\u0000')}\u0000${index}`,
        path: `M ${startX} ${startY} C ${firstControlX} ${startY}, ${secondControlX} ${endY}, ${endX} ${endY}`,
        labelX: (startX + endX) / 2,
        labelY: (startY + endY) / 2
      }
    ]
  })

  return { width: canvasWidth, height: canvasHeight, nodes, edges }
}

/** 在当前已加载的精确边中寻找一条从 source 到 target 的最短路径。 */
export function findDependencyPath(edges: LoreDependencyGraphEdge[], source: string, target: string): string[] | null {
  if (!source || !target) return null
  if (source === target) return [source]

  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    const targets = adjacency.get(edge.sourcePath) ?? []
    if (!targets.includes(edge.dependencyPath)) targets.push(edge.dependencyPath)
    adjacency.set(edge.sourcePath, targets)
  }

  const visited = new Set([source])
  const queue: string[][] = [[source]]
  while (queue.length > 0) {
    const path = queue.shift()
    if (!path) break
    const current = path[path.length - 1]
    for (const next of adjacency.get(current) ?? []) {
      if (next === target) return [...path, next]
      if (visited.has(next)) continue
      visited.add(next)
      queue.push([...path, next])
    }
  }
  return null
}

/** 返回第一条确定性循环路径；无循环时返回空值。 */
export function findDependencyCycle(edges: LoreDependencyGraphEdge[]): string[] | null {
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    const targets = adjacency.get(edge.sourcePath) ?? []
    if (!targets.includes(edge.dependencyPath)) targets.push(edge.dependencyPath)
    adjacency.set(edge.sourcePath, targets)
  }
  for (const targets of adjacency.values()) targets.sort()

  const visited = new Set<string>()
  const active = new Set<string>()
  const stack: string[] = []

  const visit = (node: string): string[] | null => {
    visited.add(node)
    active.add(node)
    stack.push(node)
    for (const target of adjacency.get(node) ?? []) {
      if (!visited.has(target)) {
        const cycle = visit(target)
        if (cycle) return cycle
      } else if (active.has(target)) {
        const cycleStart = stack.indexOf(target)
        return [...stack.slice(cycleStart), target]
      }
    }
    stack.pop()
    active.delete(node)
    return null
  }

  const nodes = [...new Set([...adjacency.keys(), ...[...adjacency.values()].flat()])].sort()
  for (const node of nodes) {
    if (visited.has(node)) continue
    const cycle = visit(node)
    if (cycle) return cycle
  }
  return null
}

/** 文件卡片只显示末段名称，完整仓库相对路径仍保留在 title 与详情区。 */
export function dependencyPathLabel(path: string): string {
  const parts = path.replaceAll('\\', '/').split('/').filter(Boolean)
  return parts.at(-1) ?? path
}

export function dependencyPathDirectory(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const separator = normalized.lastIndexOf('/')
  return separator > 0 ? normalized.slice(0, separator) : '.'
}
