import { describe, expect, it } from 'vitest'

import { combineUnifiedPatches, countUnifiedDiffLines, parseUnifiedDiff } from './unifiedDiff'

describe('unified diff parsing', () => {
  it('advances old and new line numbers independently while parsing a hunk', () => {
    const lines = parseUnifiedDiff('@@ -10,3 +10,3 @@\n keep\n-old\n+new\n tail')
    expect(lines.slice(1)).toEqual([
      expect.objectContaining({ kind: 'context', oldLine: 10, newLine: 10 }),
      expect.objectContaining({ kind: 'deletion', oldLine: 11 }),
      expect.objectContaining({ kind: 'addition', newLine: 11 }),
      expect.objectContaining({ kind: 'context', oldLine: 12, newLine: 12 })
    ])
  })

  it('ignores empty files and preserves path headers when merging patches', () => {
    expect(
      combineUnifiedPatches([
        { path: 'a.txt', patch: '@@ -1 +1 @@\n-a\n+b\n' },
        { path: 'b.bin', patch: '' }
      ])
    ).toBe('# a.txt\n@@ -1 +1 @@\n-a\n+b')
  })

  it('counts only actual added and deleted content lines', () => {
    const lines = parseUnifiedDiff('--- a/file.txt\n+++ b/file.txt\n@@ -1 +1,2 @@\n-old\n+new\n+extra')
    expect(countUnifiedDiffLines(lines)).toEqual({
      additions: 2,
      deletions: 1
    })
  })
})
