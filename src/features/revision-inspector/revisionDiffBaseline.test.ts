import { describe, expect, it } from 'vitest'

import { chooseRevisionDiffBaseline, loadRevisionDiffBaseline } from './revisionDiffBaseline'

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
            binary: false
          }
        ]
      }
    ])

    expect(result.sourceRevision).toBe('second-parent')
    expect(result.changes).toHaveLength(1)
  })

  it('preserves first-parent semantics when the first parent has changes', () => {
    const first = {
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
          binary: false
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
    const result = await loadRevisionDiffBaseline(['first-parent', 'second-parent'], async (sourceRevision) => {
      requestedSources.push(sourceRevision)
      return sourceRevision === 'second-parent'
        ? [
            {
              id: 'src/merged.ts',
              path: 'src',
              name: 'merged.ts',
              status: 'added',
              staged: false,
              additions: 0,
              deletions: 0,
              binary: false
            }
          ]
        : []
    })

    expect(requestedSources).toEqual(['first-parent', 'second-parent'])
    expect(result.sourceRevision).toBe('second-parent')
    expect(result.changes[0]?.name).toBe('merged.ts')
  })
})
