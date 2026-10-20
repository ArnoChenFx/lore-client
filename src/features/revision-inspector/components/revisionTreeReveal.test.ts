import { describe, expect, it } from 'bun:test'

import type { RepositoryFileReference, RevisionFile } from '../../../types'
import { resolveRevisionTreeReveal } from './revisionTreeReveal'

describe('Revision file tree reveal', () => {
  const planChange: RepositoryFileReference = {
    contentClassification: { kind: 'unknown', source: 'deferred' },
    id: 'revision-change:plan.txt',
    path: '.',
    name: 'plan.txt'
  }

  it('preserves the reveal request while the full tree is unloaded instead of reporting a missing file', () => {
    expect(resolveRevisionTreeReveal(false, [], [planChange], planChange)).toEqual({
      kind: 'pending'
    })
  })

  it('reveals a root file after the full tree loads', () => {
    const planTreeFile: RevisionFile = {
      id: 'revision-tree-file:plan.txt',
      path: '.',
      name: 'plan.txt',
      size: '12 B',
      contentClassification: { kind: 'text', source: 'utf8' }
    }

    expect(resolveRevisionTreeReveal(true, [planTreeFile], [planChange], planChange)).toEqual({
      kind: 'found',
      selectedIds: [planTreeFile.id],
      primaryId: planTreeFile.id
    })
  })

  it('reports a missing path only after the full tree has loaded', () => {
    expect(resolveRevisionTreeReveal(true, [], [planChange], planChange)).toEqual({
      kind: 'missing',
      path: 'plan.txt'
    })
  })
})
