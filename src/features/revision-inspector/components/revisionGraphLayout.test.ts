import { describe, expect, it } from 'vitest'

import type { Revision } from '../../../types'
import { calculateFlatRevisionGraphLayout, calculateRevisionGraphLayout } from './revisionGraphLayout'

function createRevision(id: string, parentIds: string[]): Revision {
  return {
    id,
    shortId: id,
    title: id,
    description: '',
    author: 'Test Author',
    initials: 'T',
    timestamp: '2026-07-25 10:00',
    relativeTime: 'just now',
    branchPointers: [],
    parentCount: parentIds.length,
    parentIds,
    filesChanged: 0,
    additions: 0,
    deletions: 0,
    size: '0 B'
  }
}

describe('revision graph lane layout', () => {
  it('projects arbitrary topology into one continuous Lore flat lane', () => {
    const layout = calculateFlatRevisionGraphLayout([
      createRevision('merge', ['main-parent', 'side-parent']),
      createRevision('side-parent', ['main-parent']),
      createRevision('main-parent', [])
    ])

    expect(layout.laneCount).toBe(1)
    expect(layout.rows.map((row) => row.nodeLane)).toEqual([0, 0, 0])
    expect(layout.rows.map((row) => row.nodeRole)).toEqual(['main', 'main', 'main'])
    expect(layout.rows.map((row) => row.nodeColorIndex)).toEqual([0, 0, 0])
    expect(layout.rows.map((row) => row.lines[0])).toEqual([
      {
        id: 'merge:flat',
        topLane: undefined,
        nodeLane: 0,
        bottomLane: 0,
        role: 'main',
        colorIndex: 0
      },
      {
        id: 'side-parent:flat',
        topLane: 0,
        nodeLane: 0,
        bottomLane: 0,
        role: 'main',
        colorIndex: 0
      },
      {
        id: 'main-parent:flat',
        topLane: 0,
        nodeLane: 0,
        bottomLane: undefined,
        role: 'main',
        colorIndex: 0
      }
    ])
    expect(layout.rows[0].isMerge).toBe(true)
  })

  it('renders a single flat revision as an isolated node', () => {
    const layout = calculateFlatRevisionGraphLayout([createRevision('only', [])])

    expect(layout).toMatchObject({
      laneCount: 1,
      rows: [
        {
          revisionId: 'only',
          nodeLane: 0,
          nodeRole: 'main',
          lines: []
        }
      ]
    })
  })

  it('keeps linear history on one main lane', () => {
    const layout = calculateRevisionGraphLayout([
      createRevision('newest', ['middle']),
      createRevision('middle', ['root']),
      createRevision('root', [])
    ])

    expect(layout.laneCount).toBe(1)
    expect(layout.rows.map((row) => row.nodeLane)).toEqual([0, 0, 0])
    expect(layout.rows.map((row) => row.nodeRole)).toEqual(['main', 'main', 'main'])
    expect(layout.rows.map((row) => row.nodeColorIndex)).toEqual([0, 0, 0])
    expect(layout.rows[1].lines).toEqual([
      {
        id: 'middle:primary',
        topLane: 0,
        nodeLane: 0,
        bottomLane: 0,
        role: 'main',
        colorIndex: 0
      }
    ])
  })

  it('opens side lanes for multiple parents and converges at the shared parent', () => {
    const layout = calculateRevisionGraphLayout([
      createRevision('merge', ['main-parent', 'side-parent']),
      createRevision('side-parent', ['main-parent']),
      createRevision('main-parent', [])
    ])

    expect(layout.laneCount).toBe(2)
    expect(layout.rows[0]).toMatchObject({
      nodeLane: 0,
      nodeRole: 'main',
      nodeColorIndex: 0,
      isMerge: true,
      lines: [
        {
          id: 'merge:primary',
          nodeLane: 0,
          bottomLane: 0,
          role: 'main',
          colorIndex: 0
        },
        {
          id: 'merge:parent:side-parent',
          nodeLane: 0,
          bottomLane: 1,
          role: 'merge',
          colorIndex: 1
        }
      ]
    })
    expect(layout.rows[1]).toMatchObject({
      nodeLane: 1,
      nodeRole: 'branch',
      nodeColorIndex: 1,
      isMerge: false,
      lines: [
        {
          id: 'side-parent:pass:main-parent',
          topLane: 0,
          bottomLane: 0,
          role: 'main',
          colorIndex: 0
        },
        {
          id: 'side-parent:primary',
          topLane: 1,
          nodeLane: 1,
          bottomLane: 0,
          role: 'branch',
          colorIndex: 1
        }
      ]
    })
    expect(layout.rows[2].nodeLane).toBe(0)
  })

  it('connects a newly visible branch only from its node to an active parent lane', () => {
    const layout = calculateRevisionGraphLayout([
      createRevision('main-child', ['shared-parent']),
      createRevision('side-tip', ['shared-parent']),
      createRevision('shared-parent', [])
    ])
    const sideRow = layout.rows[1]

    expect(sideRow.nodeLane).toBe(1)
    expect(sideRow.nodeColorIndex).toBe(1)
    expect(sideRow.lines).toEqual([
      {
        id: 'side-tip:pass:shared-parent',
        topLane: 0,
        bottomLane: 0,
        role: 'main',
        colorIndex: 0
      },
      {
        id: 'side-tip:primary',
        topLane: undefined,
        nodeLane: 1,
        bottomLane: 0,
        role: 'branch',
        colorIndex: 1
      }
    ])
  })

  it('keeps parents outside the page as active lanes extending to the viewport edge', () => {
    const layout = calculateRevisionGraphLayout([
      createRevision('merge', ['visible-parent', 'outside-parent']),
      createRevision('visible-parent', ['visible-root']),
      createRevision('visible-root', [])
    ])

    expect(layout.laneCount).toBe(2)
    expect(layout.rows[1].lines).toContainEqual({
      id: 'visible-parent:pass:outside-parent',
      topLane: 1,
      bottomLane: 1,
      role: 'branch',
      colorIndex: 1
    })
    expect(layout.rows[2].lines).toContainEqual({
      id: 'visible-root:pass:outside-parent',
      topLane: 1,
      bottomLane: 0,
      role: 'branch',
      colorIndex: 1
    })
  })

  it('assigns distinct colors to source lanes in discovery order', () => {
    /*
     * 两个来源分支不会同时保持到窗口底部，但它们是不同的逻辑 lane。
     * 颜色游标应继续前进，而不是每次都把新支线重置为固定红色。
     */
    const layout = calculateRevisionGraphLayout([
      createRevision('merge-a', ['merge-b', 'side-a']),
      createRevision('side-a', ['merge-b']),
      createRevision('merge-b', ['root', 'side-b']),
      createRevision('side-b', ['root']),
      createRevision('root', [])
    ])
    const firstSource = layout.rows[0].lines.find((line) => line.role === 'merge')
    const secondSource = layout.rows[2].lines.find((line) => line.role === 'merge')

    expect(firstSource?.colorIndex).toBe(1)
    expect(secondSource?.colorIndex).toBe(2)
    expect(firstSource?.colorIndex).not.toBe(secondSource?.colorIndex)
  })

  it('preserves lane color identity when lanes move horizontally', () => {
    const layout = calculateRevisionGraphLayout([
      createRevision('merge', ['main-parent', 'outside-parent']),
      createRevision('main-parent', ['root']),
      createRevision('root', [])
    ])
    const beforeShift = layout.rows[1].lines.find((line) => line.id === 'main-parent:pass:outside-parent')
    const shifting = layout.rows[2].lines.find((line) => line.id === 'root:pass:outside-parent')

    expect(beforeShift).toMatchObject({
      topLane: 1,
      bottomLane: 1,
      colorIndex: 1
    })
    expect(shifting).toMatchObject({
      topLane: 1,
      bottomLane: 0,
      colorIndex: 1
    })
  })

  it('avoids repeated colors across eight lanes and cycles deterministically afterward', () => {
    const parentIds = Array.from({ length: 9 }, (_, index) => `parent-${index}`)
    const layout = calculateRevisionGraphLayout([createRevision('wide-merge', parentIds)])
    const colors = layout.rows[0].lines.map((line) => line.colorIndex)

    /*
     * 第一父修订继承主 lane 的 0 号色，七条额外父 lane 依次拿到 1~7。
     * 第九条同时活跃的 lane 超出八色容量后才循环到 0，行为必须稳定。
     */
    expect(colors.slice(0, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(new Set(colors.slice(0, 8)).size).toBe(8)
    expect(colors[8]).toBe(0)
  })

  it('ignores duplicate, self-referential, and empty parent IDs', () => {
    const damaged = createRevision('damaged', ['damaged', '', 'parent', 'parent'])
    const layout = calculateRevisionGraphLayout([damaged, createRevision('parent', [])])

    expect(layout.laneCount).toBe(1)
    expect(layout.rows[0].isMerge).toBe(false)
    expect(layout.rows[0].lines).toHaveLength(1)
    expect(layout.rows[1].nodeLane).toBe(0)
  })

  it('keeps layout stable when branch labels change but parent IDs do not', () => {
    const withoutLabels = [createRevision('child', ['parent']), createRevision('parent', [])]
    const withLabels = withoutLabels.map((revision, index) => ({
      ...revision,
      branchPointers:
        index === 0
          ? [
              { id: 'local:feature/example', name: 'feature/example', kind: 'local' as const },
              { id: 'head', name: 'HEAD', kind: 'head' as const }
            ]
          : [{ id: 'remote:origin/main', name: 'origin/main', kind: 'remote' as const }]
    }))

    expect(calculateRevisionGraphLayout(withLabels)).toEqual(calculateRevisionGraphLayout(withoutLabels))
  })
})
