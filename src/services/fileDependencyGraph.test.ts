import { describe, expect, it, vi } from 'vitest'

import type { LoreDependencyQuery, LoreDependencySelection } from '../types'
import { collectFileDependencyGraph } from './lore'

const recursiveSelection: LoreDependencySelection = {
  rootFiles: ['A'],
  tags: [],
  recursive: true,
  depthLimit: 0
}

function directQuery(groups: LoreDependencyQuery['groups'], reverse = false): LoreDependencyQuery {
  return { groups, reverse, recursive: false, depthLimit: 1 }
}

describe('file dependency graph collection', () => {
  it('rebuilds exact transitive edges from breadth-first direct batches', async () => {
    const loadDirectBatch = vi.fn(async (paths: string[]) => {
      const groups = paths.map((path) => {
        if (path === 'A') {
          return {
            path,
            entries: [
              { path: 'B', tags: ['runtime'], depth: 0 },
              { path: 'C', tags: [], depth: 0 }
            ]
          }
        }
        if (path === 'B' || path === 'C') {
          return { path, entries: [{ path: 'D', tags: [path.toLowerCase()], depth: 0 }] }
        }
        return { path, entries: [] }
      })
      return directQuery(groups)
    })

    const result = await collectFileDependencyGraph(['A'], recursiveSelection, false, 'revision-1', loadDirectBatch)

    expect(loadDirectBatch.mock.calls.map(([paths]) => paths)).toEqual([['A'], ['B', 'C'], ['D']])
    expect(result.nodes).toEqual([
      { path: 'A', distance: 0, root: true },
      { path: 'B', distance: 1, root: false },
      { path: 'C', distance: 1, root: false },
      { path: 'D', distance: 2, root: false }
    ])
    expect(result.edges).toEqual([
      { sourcePath: 'A', dependencyPath: 'B', tags: ['runtime'] },
      { sourcePath: 'A', dependencyPath: 'C', tags: [] },
      { sourcePath: 'B', dependencyPath: 'D', tags: ['b'] },
      { sourcePath: 'C', dependencyPath: 'D', tags: ['c'] }
    ])
    expect(result.truncated).toBe(false)
  })

  it('keeps real source-to-dependency edge direction during reverse traversal', async () => {
    const loadDirectBatch = vi.fn(async (paths: string[]) => {
      const groups = paths.map((path) => {
        if (path === 'D') {
          return {
            path,
            entries: [
              { path: 'B', tags: [], depth: 0 },
              { path: 'C', tags: [], depth: 0 }
            ]
          }
        }
        if (path === 'B' || path === 'C') {
          return { path, entries: [{ path: 'A', tags: ['runtime'], depth: 0 }] }
        }
        return { path, entries: [] }
      })
      return directQuery(groups, true)
    })

    const result = await collectFileDependencyGraph(
      ['D'],
      { ...recursiveSelection, rootFiles: ['D'] },
      true,
      'revision-2',
      loadDirectBatch
    )

    expect(result.edges).toEqual([
      { sourcePath: 'A', dependencyPath: 'B', tags: ['runtime'] },
      { sourcePath: 'A', dependencyPath: 'C', tags: ['runtime'] },
      { sourcePath: 'B', dependencyPath: 'D', tags: [] },
      { sourcePath: 'C', dependencyPath: 'D', tags: [] }
    ])
    expect(result.nodes.find((node) => node.path === 'A')?.distance).toBe(2)
  })

  it('stops expansion at the requested depth without dropping direct edges', async () => {
    const loadDirectBatch = vi.fn(async (paths: string[]) =>
      directQuery(
        paths.map((path) => ({
          path,
          entries: [{ path: `${path}-child`, tags: [], depth: 0 }]
        }))
      )
    )

    const result = await collectFileDependencyGraph(
      ['A'],
      { ...recursiveSelection, depthLimit: 1 },
      false,
      'revision-3',
      loadDirectBatch
    )

    expect(loadDirectBatch).toHaveBeenCalledTimes(1)
    expect(result.nodes.map((node) => node.path)).toEqual(['A', 'A-child'])
    expect(result.edges).toHaveLength(1)
  })

  it('marks bounded results as truncated and omits edges whose endpoint was not admitted', async () => {
    const result = await collectFileDependencyGraph(
      ['A'],
      recursiveSelection,
      false,
      'revision-4',
      async () =>
        directQuery([
          {
            path: 'A',
            entries: [
              { path: 'B', tags: [], depth: 0 },
              { path: 'C', tags: [], depth: 0 },
              { path: 'D', tags: [], depth: 0 }
            ]
          }
        ]),
      3
    )

    expect(result.truncated).toBe(true)
    expect(result.nodes.map((node) => node.path)).toEqual(['A', 'B', 'C'])
    expect(result.edges.map((edge) => edge.dependencyPath)).toEqual(['B', 'C'])
  })
})
