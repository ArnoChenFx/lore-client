import { describe, expect, it } from 'bun:test'

import type { ChangeFile } from '../../types'
import {
  chooseRevisionDiffBaseline,
  loadRevisionDiffBaseline,
  type RevisionDiffBaselineResult
} from './revisionDiffBaseline'

describe('chooseRevisionDiffBaseline', () => {
  it('selects the first nonempty parent Diff when a merge Revision has an empty first-parent Diff', () => {
    const result = chooseRevisionDiffBaseline([
      { sourceRevision: 'first-parent', changes: [] },
      {
        sourceRevision: 'second-parent',
        changes: [
          {
            id: 'src/main.ts',
            path: 'src',
            name: 'main.ts',
            status: 'modified',
            staged: false,
            additions: 0,
            deletions: 0,
            contentClassification: { kind: 'text', source: 'utf8' }
          }
        ]
      }
    ])

    expect(result.sourceRevision).toBe('second-parent')
    expect(result.changes).toHaveLength(1)
  })

  it('preserves first-parent semantics when the first parent has changes', () => {
    const first: RevisionDiffBaselineResult = {
      sourceRevision: 'first-parent',
      changes: [
        {
          id: 'README.md',
          path: '.',
          name: 'README.md',
          status: 'modified' as const,
          staged: false,
          additions: 0,
          deletions: 0,
          contentClassification: { kind: 'text', source: 'utf8' }
        }
      ]
    }

    expect(
      chooseRevisionDiffBaseline([
        first,
        {
          sourceRevision: 'second-parent',
          changes: []
        }
      ])
    ).toBe(first)
  })

  it('loads every merge Revision parent through the production scheduling semantics', async () => {
    const requestedSources: Array<string | null> = []
    let activeLoads = 0
    let maximumActiveLoads = 0
    const result = await loadRevisionDiffBaseline(['first-parent', 'second-parent'], async (sourceRevision) => {
      requestedSources.push(sourceRevision)
      activeLoads += 1
      maximumActiveLoads = Math.max(maximumActiveLoads, activeLoads)
      await Promise.resolve()
      const changes: ChangeFile[] =
        sourceRevision === 'second-parent'
          ? [
              {
                id: 'src/merged.ts',
                path: 'src',
                name: 'merged.ts',
                status: 'added' as const,
                staged: false,
                additions: 0,
                deletions: 0,
                contentClassification: { kind: 'text', source: 'utf8' }
              }
            ]
          : []
      activeLoads -= 1
      return changes
    })

    expect(requestedSources).toEqual(['first-parent', 'second-parent'])
    expect(maximumActiveLoads).toBe(1)
    expect(result.sourceRevision).toBe('second-parent')
    expect(result.changes[0]?.name).toBe('merged.ts')
  })
})
