import { describe, expect, it } from 'vitest'

import { readMoveSourceFromPatch } from './moveSource'

describe('readMoveSourceFromPatch', () => {
  it('reads the source path from the Lore move header', () => {
    const patch = 'move from Content/World/Old.umap\nmove to Content/World/New.umap\ndiff --git a/x b/y\n'
    expect(readMoveSourceFromPatch(patch)).toBe('Content/World/Old.umap')
  })

  it('reads the source path from a binary move that has no hunks', () => {
    /* 二进制移动仍然带补丁头，这是唯一能拿到旧路径的地方。 */
    const patch = 'move from Content/Old.bin\nmove to Content/New.bin\nBinary files differ\n'
    expect(readMoveSourceFromPatch(patch)).toBe('Content/Old.bin')
  })

  it('normalizes separators to forward slashes', () => {
    const patch = 'move from Content\\World\\Old.umap\nmove to Content\\World\\New.umap\n'
    expect(readMoveSourceFromPatch(patch)).toBe('Content/World/Old.umap')
  })

  it('returns undefined when no move header is present', () => {
    expect(readMoveSourceFromPatch('')).toBeUndefined()
    expect(readMoveSourceFromPatch('diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-a\n+b\n')).toBeUndefined()
  })

  it('ignores a move-from line that only appears inside the patch body', () => {
    /* 头部结束（`diff --git` / `@@`）之后的正文不属于头部，不得当成来源路径。 */
    const patch = 'diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n+move from fake.txt\n'
    expect(readMoveSourceFromPatch(patch)).toBeUndefined()
  })

  it('treats an empty move-from line as no source path', () => {
    expect(readMoveSourceFromPatch('move from \nmove to b.txt\n')).toBeUndefined()
  })
})
