import type { Revision } from '../../../types'

export type RevisionGraphLineRole = 'main' | 'branch' | 'merge'

/**
 * Revision 图谱使用八个受控类别色。
 *
 * 颜色数量同时约束布局分配器和 SVG 样式索引；在常见桌面历史窗口中，
 * 八条以内同时活跃的 lane 可以完全避免重色，超过后才按顺序循环。
 */
export const REVISION_LANE_COLOR_COUNT = 8

/**
 * 一条行内线段的拓扑描述。
 *
 * - `topLane` 表示线段从当前行上边界进入；
 * - `nodeLane` 表示线段经过当前 Revision 节点；
 * - `bottomLane` 表示线段从当前行下边界离开。
 *
 * 直通线没有 `nodeLane`；窗口顶部新出现的 Revision 没有 `topLane`；
 * 根 Revision 没有 `bottomLane`。SVG 组件只消费这些明确端点，不再猜测
 * “主线、支线或合并应该长什么样”。
 */
export interface RevisionGraphLine {
  id: string
  topLane?: number
  nodeLane?: number
  bottomLane?: number
  role: RevisionGraphLineRole
  /** 逻辑 lane 的稳定颜色索引，不由当前横向列位或线段角色推导。 */
  colorIndex: number
}

/** 单个可见 Revision 行已经计算完成的 lane 布局。 */
export interface RevisionGraphRowLayout {
  revisionId: string
  nodeLane: number
  nodeRole: 'main' | 'branch'
  /** 节点必须与进入和离开该节点的逻辑 lane 使用相同颜色。 */
  nodeColorIndex: number
  isMerge: boolean
  lines: RevisionGraphLine[]
}

/** 整个可见窗口共享一个 lane 数量，保证相邻行的横坐标完全一致。 */
export interface RevisionGraphLayout {
  laneCount: number
  rows: RevisionGraphRowLayout[]
}

/**
 * 把可见 Revision 投影为 Lore 默认的连续单道列表。
 *
 * 该模式有意不表达父子拓扑：排序仍完全沿用 History 查询结果，第一行从
 * 节点向下延伸，中间行贯穿，末行在节点处结束。这样筛选后的不连续历史
 * 也保持 Lore 单道视图的平铺语义，而不会伪造跨道分支关系。
 */
export function calculateFlatRevisionGraphLayout(revisions: readonly Revision[]): RevisionGraphLayout {
  const lastIndex = revisions.length - 1
  return {
    laneCount: 1,
    rows: revisions.map((revision, index) => ({
      revisionId: revision.id,
      nodeLane: 0,
      nodeRole: 'main',
      nodeColorIndex: 0,
      isMerge: validParentIds(revision).length > 1,
      lines:
        revisions.length <= 1
          ? []
          : [
              {
                id: `${revision.id}:flat`,
                topLane: index > 0 ? 0 : undefined,
                nodeLane: 0,
                bottomLane: index < lastIndex ? 0 : undefined,
                role: 'main',
                colorIndex: 0
              }
            ]
    }))
  }
}

/** active lane 同时保存其下一目标 Revision 与持续不变的颜色身份。 */
interface ActiveLane {
  revisionId: string
  colorIndex: number
}

/**
 * 去除无效、自指和重复父修订。
 *
 * DTO 在正常路径中已经满足这些约束，但布局层仍保持防御性：损坏的单条
 * 历史记录不应让 active lane 重复增长，也不能制造无意义的自环。
 */
function validParentIds(revision: Revision): string[] {
  return Array.from(new Set(revision.parentIds.filter((parentId) => parentId.length > 0 && parentId !== revision.id)))
}

/** 只要线段触及非零 lane，它就属于结构性支线。 */
function structuralLineRole(...lanes: Array<number | undefined>): Exclude<RevisionGraphLineRole, 'merge'> {
  return lanes.some((lane) => lane !== undefined && lane > 0) ? 'branch' : 'main'
}

/**
 * 根据“新到旧”的可见 Revision 顺序计算图谱 lane。
 *
 * `activeLanes` 保存从上一行下边界继续向更早历史延伸的 Revision ID。
 * 当前 Revision 出现在其中时，说明有可见子修订连接到它；不在其中时，
 * 它是窗口顶部、筛选结果或分页边界中新出现的图谱端点。处理当前节点后：
 *
 * 1. 第一父修订接替当前 lane，表达当前历史方向的连续性；
 * 2. 其他父修订占用独立 lane，表达真实的多父拓扑；
 * 3. 已经活跃的父修订只复用现有 lane，避免重复线路；
 * 4. 与当前节点无关的 lane 显式生成直通线，并在 lane 收缩时平滑换位。
 *
 * 计算过程只读取 `id` 与 `parentIds`，不会读取分支名、标签、旧 `track`
 * 或行内视觉状态，因此演示数据和真实 Lore 历史共享完全相同的结果。
 */
export function calculateRevisionGraphLayout(revisions: readonly Revision[]): RevisionGraphLayout {
  let activeLanes: ActiveLane[] = []
  let nextColorCursor = 0
  let laneCount = 1
  const rows: RevisionGraphRowLayout[] = []

  /**
   * 从游标位置开始寻找当前未被占用的颜色。
   *
   * 游标不会在 lane 收束时回退，因此先后出现的短分支也会依次获得不同
   * 颜色；只有八色全部被占用或游标完整循环后才会复用。
   */
  const allocateColorIndex = (occupiedColors: ReadonlySet<number>): number => {
    for (let offset = 0; offset < REVISION_LANE_COLOR_COUNT; offset += 1) {
      const candidate = (nextColorCursor + offset) % REVISION_LANE_COLOR_COUNT
      if (!occupiedColors.has(candidate)) {
        nextColorCursor = (candidate + 1) % REVISION_LANE_COLOR_COUNT
        return candidate
      }
    }

    /*
     * 极端历史可能同时超过八条 lane。此时按游标循环仍能保持确定性，
     * 并优先让相邻的新 lane 使用不同的后续颜色。
     */
    const candidate = nextColorCursor
    nextColorCursor = (nextColorCursor + 1) % REVISION_LANE_COLOR_COUNT
    return candidate
  }

  for (const revision of revisions) {
    const parents = validParentIds(revision)
    const topLanes = [...activeLanes]
    let nodeLane = topLanes.findIndex((lane) => lane.revisionId === revision.id)
    const entersFromTop = nodeLane >= 0

    /*
     * 一个没有可见子修订的节点从当前行中部开始。把它追加到最右侧可以
     * 保持所有既有 lane 的横坐标不变，避免筛选或分页端点使主线抖动。
     */
    const rowLanes = [...topLanes]
    if (!entersFromTop) {
      nodeLane = rowLanes.length
      rowLanes.push({
        revisionId: revision.id,
        colorIndex: allocateColorIndex(new Set(rowLanes.map((lane) => lane.colorIndex)))
      })
    }
    const nodeColorIndex = rowLanes[nodeLane].colorIndex

    // 当前节点会被它的父修订替换；没有父修订时，这条 lane 在节点处结束。
    const bottomLanes = rowLanes.filter((lane) => lane.revisionId !== revision.id)
    let insertionCursor = Math.min(nodeLane, bottomLanes.length)

    for (const [parentIndex, parentId] of parents.entries()) {
      const existingLane = bottomLanes.findIndex((lane) => lane.revisionId === parentId)
      if (existingLane >= 0) {
        /*
         * 后续新增父 lane 应放在已经复用的父 lane 之后，同时不越过当前
         * 节点原来的位置太远，从而尽量减少不相关线路的横向换位。
         */
        insertionCursor = Math.max(insertionCursor, existingLane + 1)
        continue
      }

      /*
       * 第一父修订是当前逻辑 lane 的延续，必须继承节点颜色。第二及后续
       * 父修订代表新展开的来源 lane，领取新的调色板颜色。
       */
      const colorIndex =
        parentIndex === 0
          ? nodeColorIndex
          : allocateColorIndex(new Set([...rowLanes, ...bottomLanes].map((lane) => lane.colorIndex)))
      bottomLanes.splice(insertionCursor, 0, {
        revisionId: parentId,
        colorIndex
      })
      insertionCursor += 1
    }

    const lines: RevisionGraphLine[] = []

    /*
     * 先绘制与当前节点无关的活跃 lane。若当前 lane 被删除，右侧线路会
     * 显式连接到新的下边界位置，而不是依靠下一行碰巧补齐。
     */
    for (const [topLane, lane] of rowLanes.entries()) {
      if (lane.revisionId === revision.id) {
        continue
      }

      const bottomLane = bottomLanes.findIndex((candidate) => candidate.revisionId === lane.revisionId)
      if (bottomLane < 0) {
        continue
      }

      lines.push({
        id: `${revision.id}:pass:${lane.revisionId}`,
        topLane,
        bottomLane,
        role: structuralLineRole(topLane, bottomLane),
        colorIndex: lane.colorIndex
      })
    }

    const primaryParentLane = parents.length > 0 ? bottomLanes.findIndex((lane) => lane.revisionId === parents[0]) : -1
    if (entersFromTop || primaryParentLane >= 0) {
      lines.push({
        id: `${revision.id}:primary`,
        topLane: entersFromTop ? nodeLane : undefined,
        nodeLane,
        bottomLane: primaryParentLane >= 0 ? primaryParentLane : undefined,
        role: structuralLineRole(
          entersFromTop ? nodeLane : undefined,
          nodeLane,
          primaryParentLane >= 0 ? primaryParentLane : undefined
        ),
        /*
         * 即使第一父修订已存在于另一 lane，汇入节点之前的曲线仍属于
         * 当前来源 lane，因此使用节点颜色而不是目标列颜色。
         */
        colorIndex: nodeColorIndex
      })
    }

    /*
     * 第二及后续父修订是当前 Revision 的额外父边。它们从节点开始，
     * 不得再次从行顶部进入，否则会重现旧组件“一行两条支线路径”的问题。
     */
    for (const [parentIndex, parentId] of parents.entries()) {
      if (parentIndex === 0) {
        continue
      }

      const bottomLane = bottomLanes.findIndex((lane) => lane.revisionId === parentId)
      if (bottomLane < 0) {
        continue
      }

      lines.push({
        id: `${revision.id}:parent:${parentId}`,
        nodeLane,
        bottomLane,
        role: 'merge',
        /*
         * 第二父修订边属于被合入的来源 lane。颜色取自该父修订在下边界
         * 的 active lane，保证转接曲线与下一行延续段完全一致。
         */
        colorIndex: bottomLanes[bottomLane].colorIndex
      })
    }

    laneCount = Math.max(laneCount, rowLanes.length, bottomLanes.length, nodeLane + 1)
    rows.push({
      revisionId: revision.id,
      nodeLane,
      nodeRole: nodeLane === 0 ? 'main' : 'branch',
      nodeColorIndex,
      isMerge: parents.length > 1,
      lines
    })
    activeLanes = bottomLanes
  }

  return { laneCount, rows }
}
