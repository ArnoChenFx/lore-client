import { describe, expect, it } from 'vitest'

import { browserDependencyGraphFixture, shouldUseBrowserDependencyGraphFixture } from './dependencyGraphFixture'

describe('browser dependency graph fixture', () => {
  it('only enables the fixture in the project browser-demo mode', () => {
    expect(shouldUseBrowserDependencyGraphFixture('browser-demo')).toBe(true)
    expect(shouldUseBrowserDependencyGraphFixture('tauri')).toBe(false)
  })

  it('keeps every fixture edge endpoint backed by a declared node', () => {
    const nodePaths = new Set(browserDependencyGraphFixture.nodes.map((node) => node.path))

    for (const edge of browserDependencyGraphFixture.edges) {
      expect(nodePaths.has(edge.sourcePath), `缺少来源节点：${edge.sourcePath}`).toBe(true)
      expect(nodePaths.has(edge.dependencyPath), `缺少依赖节点：${edge.dependencyPath}`).toBe(true)
    }
  })
})
