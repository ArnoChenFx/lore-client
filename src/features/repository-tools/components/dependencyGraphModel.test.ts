import { describe, expect, it } from 'vitest'

import type { LoreDependencyGraphQuery } from '../../../types'
import {
  dependencyGraphPanOffsetAfterZoom,
  dependencyPathDirectory,
  dependencyPathLabel,
  findDependencyCycle,
  findDependencyPath,
  layoutDependencyGraph
} from './dependencyGraphModel'

function graphQuery(reverse = false): LoreDependencyGraphQuery {
  return {
    revision: 'revision-1',
    groups: [],
    nodes: [
      { path: 'Content/A.asset', distance: 0, root: true },
      { path: 'Content/B.asset', distance: 1, root: false },
      { path: 'Content/C.asset', distance: 2, root: false }
    ],
    edges: [
      { sourcePath: 'Content/A.asset', dependencyPath: 'Content/B.asset', tags: ['runtime'] },
      { sourcePath: 'Content/B.asset', dependencyPath: 'Content/C.asset', tags: [] }
    ],
    reverse,
    recursive: true,
    depthLimit: 0,
    truncated: false,
    nodeLimit: 240
  }
}

describe('dependency graph model', () => {
  it('lays out forward and reverse traversals without reversing dependency semantics', () => {
    const forward = layoutDependencyGraph(graphQuery())
    const reverse = layoutDependencyGraph({
      ...graphQuery(true),
      nodes: [
        { path: 'Content/C.asset', distance: 0, root: true },
        { path: 'Content/B.asset', distance: 1, root: false },
        { path: 'Content/A.asset', distance: 2, root: false }
      ]
    })

    const forwardA = forward.nodes.find((node) => node.path.endsWith('A.asset'))
    const forwardC = forward.nodes.find((node) => node.path.endsWith('C.asset'))
    const reverseA = reverse.nodes.find((node) => node.path.endsWith('A.asset'))
    const reverseC = reverse.nodes.find((node) => node.path.endsWith('C.asset'))
    expect(forwardA!.x).toBeLessThan(forwardC!.x)
    expect(reverseA!.x).toBeLessThan(reverseC!.x)
    expect(reverse.edges[0]).toMatchObject({
      sourcePath: 'Content/A.asset',
      dependencyPath: 'Content/B.asset'
    })
  })

  it('finds the shortest path and a deterministic cycle', () => {
    const edges = [
      { sourcePath: 'A', dependencyPath: 'B', tags: [] },
      { sourcePath: 'B', dependencyPath: 'C', tags: [] },
      { sourcePath: 'C', dependencyPath: 'A', tags: [] },
      { sourcePath: 'A', dependencyPath: 'D', tags: [] }
    ]

    expect(findDependencyPath(edges, 'A', 'C')).toEqual(['A', 'B', 'C'])
    expect(findDependencyCycle(edges)).toEqual(['A', 'B', 'C', 'A'])
  })

  it('normalizes Windows separators for compact node labels', () => {
    expect(dependencyPathLabel('Content\\Maps\\World.umap')).toBe('World.umap')
    expect(dependencyPathDirectory('Content\\Maps\\World.umap')).toBe('Content/Maps')
  })

  it('keeps the graph coordinate beneath the pointer stable while zooming', () => {
    const nextPan = dependencyGraphPanOffsetAfterZoom(-240, 160, 1, 1.25)

    expect(nextPan).toBe(-340)
    expect((160 - -240) / 1).toBe((160 - nextPan) / 1.25)
  })
})
