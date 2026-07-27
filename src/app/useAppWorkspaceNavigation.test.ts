import { describe, expect, it } from 'vitest'

import type { Branch, ChangeFile, Revision } from '../types'
import { nextRevisionRevealRequest, resolveSearchNavigation } from './useAppWorkspaceNavigation'

describe('application workspace navigation', () => {
  it('routes a revision result to history with the exact revision ID', () => {
    const revision = { id: 'revision-42' } as Revision

    expect(
      resolveSearchNavigation({
        kind: 'revision',
        id: revision.id,
        title: 'Revision',
        detail: 'Revision detail',
        value: revision
      })
    ).toEqual({
      view: 'history',
      revisionId: 'revision-42'
    })
  })

  it('routes a branch result to branches with the exact branch ID', () => {
    const branch = { id: 'branch-main' } as Branch

    expect(
      resolveSearchNavigation({
        kind: 'branch',
        id: branch.id,
        title: 'Branch',
        detail: 'Branch detail',
        value: branch
      })
    ).toEqual({
      view: 'branches',
      branchId: 'branch-main'
    })
  })

  it('routes a change result to the changes inspector', () => {
    const change = { id: 'change-file' } as ChangeFile

    expect(
      resolveSearchNavigation({
        kind: 'change',
        id: change.id,
        title: 'Change',
        detail: 'Change detail',
        value: change
      })
    ).toEqual({
      view: 'changes',
      inspectorTab: 'changes'
    })
  })

  it('emits a new reveal sequence when the same revision is requested repeatedly', () => {
    const first = nextRevisionRevealRequest(null, 'revision-42')
    const second = nextRevisionRevealRequest(first, 'revision-42')

    expect(first).toEqual({ revisionId: 'revision-42', sequence: 1 })
    expect(second).toEqual({ revisionId: 'revision-42', sequence: 2 })
  })
})
