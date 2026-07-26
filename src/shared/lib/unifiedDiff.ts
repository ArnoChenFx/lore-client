export type UnifiedDiffLineKind = 'meta' | 'hunk' | 'context' | 'addition' | 'deletion'

export interface UnifiedDiffLine {
  id: string
  kind: UnifiedDiffLineKind
  content: string
  oldLine?: number
  newLine?: number
}

/** 把 Lore 返回的 unified patch 转成带双侧行号的稳定展示行。 */
export function parseUnifiedDiff(patch: string): UnifiedDiffLine[] {
  let oldLine = 0
  let newLine = 0

  return patch.split(/\r?\n/).map((line, index): UnifiedDiffLine => {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      return {
        id: `${index}:hunk`,
        kind: 'hunk',
        content: line
      }
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('diff ')) {
      return {
        id: `${index}:meta`,
        kind: 'meta',
        content: line
      }
    }
    if (line.startsWith('+')) {
      const current = newLine++
      return {
        id: `${index}:addition`,
        kind: 'addition',
        content: line.slice(1),
        newLine: current
      }
    }
    if (line.startsWith('-')) {
      const current = oldLine++
      return {
        id: `${index}:deletion`,
        kind: 'deletion',
        content: line.slice(1),
        oldLine: current
      }
    }
    if (line.startsWith(' ')) {
      const currentOld = oldLine++
      const currentNew = newLine++
      return {
        id: `${index}:context`,
        kind: 'context',
        content: line.slice(1),
        oldLine: currentOld,
        newLine: currentNew
      }
    }
    return {
      id: `${index}:meta`,
      kind: 'meta',
      content: line
    }
  })
}

/** 只统计已经解析为真实内容行的新增与删除，文件头和 hunk 元数据不参与计数。 */
export function countUnifiedDiffLines(lines: readonly UnifiedDiffLine[]): {
  additions: number
  deletions: number
} {
  return lines.reduce(
    (counts, line) => {
      if (line.kind === 'addition') counts.additions += 1
      if (line.kind === 'deletion') counts.deletions += 1
      return counts
    },
    { additions: 0, deletions: 0 }
  )
}

/** 合并多个文件的补丁，供复制、外部打开和保存使用。 */
export function combineUnifiedPatches(diffs: Array<{ path: string; patch: string }>): string {
  return diffs
    .filter((diff) => diff.patch.trim())
    .map((diff) => `# ${diff.path}\n${diff.patch.trimEnd()}`)
    .join('\n\n')
}
