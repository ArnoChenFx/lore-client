import type { CSSProperties } from 'react'

import type { RevisionGraphLine, RevisionGraphRowLayout } from './revisionGraphLayout'
import { REVISION_LANE_COLOR_COUNT } from './revisionGraphLayout'

interface RevisionGraphProps {
  layout: RevisionGraphRowLayout
  laneCount: number
  selected: boolean
}

const GRAPH_NODE_Y = 25
const GRAPH_LEFT_X = 17
const GRAPH_RIGHT_X = 51
const GRAPH_PREFERRED_LANE_GAP = 22

type RevisionLaneStyle = CSSProperties & {
  '--revision-lane-color': string
}

/**
 * 把布局层的颜色索引映射到主题变量。
 *
 * 布局通常已经返回 0~7，但这里继续防御非有限值与越界值，避免损坏的
 * 外部状态把 SVG stroke 退回浏览器默认黑色。
 */
function laneColorStyle(colorIndex: number): RevisionLaneStyle {
  const safeIndex = Number.isFinite(colorIndex) ? Math.trunc(colorIndex) : 0
  const normalizedIndex =
    ((safeIndex % REVISION_LANE_COLOR_COUNT) + REVISION_LANE_COLOR_COUNT) % REVISION_LANE_COLOR_COUNT
  return {
    '--revision-lane-color': `var(--revision-lane-${normalizedIndex})`
  }
}

/**
 * 所有行使用整个可见窗口的最大 lane 数量换算横坐标。
 *
 * 两条 lane 时保持旧界面的 17/39 像素位置；lane 更多时自动收紧到
 * 17~51 像素范围，既维持跨行连续，也不挤占右侧 Revision 文本列。
 */
function laneX(lane: number, laneCount: number): number {
  if (laneCount <= 1) {
    return GRAPH_LEFT_X
  }

  const laneGap = Math.min(GRAPH_PREFERRED_LANE_GAP, (GRAPH_RIGHT_X - GRAPH_LEFT_X) / (laneCount - 1))
  return GRAPH_LEFT_X + lane * laneGap
}

/** 在 lane 改变时使用竖向中点曲线，直线则避免生成多余控制点。 */
function connectPoints(fromX: number, fromY: number, toX: number, toY: number): string {
  if (fromX === toX) {
    return `L${toX} ${toY}`
  }

  const middleY = (fromY + toY) / 2
  return `C${fromX} ${middleY} ${toX} ${middleY} ${toX} ${toY}`
}

/**
 * 把显式的上边界、节点和下边界端点转换为单个 SVG path。
 *
 * 每条拓扑边在一行内最多只生成一个 path；经过节点的上下两半会拼进
 * 同一个 `d`，从结构上杜绝旧实现把支线延续与分叉重复绘制的问题。
 */
function linePath(line: RevisionGraphLine, laneCount: number): string | null {
  const points: Array<{ x: number; y: number }> = []

  if (line.topLane !== undefined) {
    points.push({ x: laneX(line.topLane, laneCount), y: 0 })
  }
  if (line.nodeLane !== undefined) {
    points.push({
      x: laneX(line.nodeLane, laneCount),
      y: GRAPH_NODE_Y
    })
  }
  if (line.bottomLane !== undefined) {
    points.push({ x: laneX(line.bottomLane, laneCount), y: 50 })
  }

  if (points.length < 2) {
    return null
  }

  let path = `M${points[0].x} ${points[0].y}`
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]
    const current = points[index]
    path += ` ${connectPoints(previous.x, previous.y, current.x, current.y)}`
  }
  return path
}

/**
 * 只负责绘制列表级布局已经给出的显式线段和节点。
 *
 * 父子关系、lane 生命周期和多父修订分配全部由
 * `calculateRevisionGraphLayout` 统一完成；组件不读取分支名称、标签，
 * 也不再接受 `track` 或 `mergeDirection` 之类的单行视觉提示。
 */
export function RevisionGraph({ layout, laneCount, selected }: RevisionGraphProps) {
  return (
    <svg
      className={`revision-graph ${layout.isMerge ? 'is-merge' : ''} ${selected ? 'is-selected' : ''}`}
      viewBox="0 0 58 50"
      preserveAspectRatio="none"
      aria-hidden="true"
      data-revision-id={layout.revisionId}
      data-node-lane={layout.nodeLane}
    >
      {layout.lines.map((line) => {
        const path = linePath(line, laneCount)
        if (!path) {
          return null
        }

        const className =
          line.role === 'main'
            ? 'revision-graph__main'
            : `revision-graph__branch ${line.role === 'merge' ? 'is-merge' : ''}`

        return (
          <path
            key={line.id}
            className={className}
            d={path}
            strokeWidth={line.role === 'main' ? '1.7' : '1.6'}
            fill="none"
            style={laneColorStyle(line.colorIndex)}
            data-color-index={line.colorIndex}
          />
        )
      })}
      <circle
        className={`revision-graph__node ${layout.nodeRole === 'branch' ? 'is-branch' : ''}`}
        cx={laneX(layout.nodeLane, laneCount)}
        cy={GRAPH_NODE_Y}
        r={selected ? '5.4' : '4.7'}
        strokeWidth="2"
        style={laneColorStyle(layout.nodeColorIndex)}
        data-color-index={layout.nodeColorIndex}
      />
      {selected && (
        <circle
          className={`revision-graph__node-core ${layout.nodeRole === 'branch' ? 'is-branch' : ''}`}
          cx={laneX(layout.nodeLane, laneCount)}
          cy={GRAPH_NODE_Y}
          r="1.7"
          style={laneColorStyle(layout.nodeColorIndex)}
          data-color-index={layout.nodeColorIndex}
        />
      )}
    </svg>
  )
}
