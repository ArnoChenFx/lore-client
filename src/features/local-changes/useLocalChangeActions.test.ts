import { describe, expect, it } from 'vitest'

import { initialChanges } from '../../demo'
import { changeFileObjectId } from '../../shared/lib'
import { reconcileChangeSelection } from './useLocalChangeActions'

describe('local change selection reconciliation', () => {
  it('preserves available selections and the current primary object', () => {
    const first = changeFileObjectId(initialChanges[0].id)
    const second = changeFileObjectId(initialChanges[1].id)
    const selection = reconcileChangeSelection(initialChanges, [first, second], second)

    expect(selection).toEqual({ selectedIds: [first, second], primaryId: second })
  })

  it('falls back to an available change after a repository refresh', () => {
    const selection = reconcileChangeSelection(initialChanges, ['file:missing'], 'file:missing')

    expect(selection.selectedIds).toHaveLength(1)
    expect(selection.primaryId).toBe(selection.selectedIds[0])
  })

  it('clears the selection when the repository has no changes', () => {
    expect(reconcileChangeSelection([], ['file:missing'], 'file:missing')).toEqual({
      selectedIds: [],
      primaryId: ''
    })
  })
})
