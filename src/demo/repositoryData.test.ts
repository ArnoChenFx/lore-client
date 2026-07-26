import { describe, expect, it } from 'vitest'

import { revisions } from './repositoryData'

describe('demo revision topology', () => {
  it('keeps each declared parent count consistent with the parent IDs', () => {
    for (const revision of revisions) {
      expect(revision.parentIds, `${revision.shortId} has inconsistent parentIds and parentCount`).toHaveLength(
        revision.parentCount
      )
    }
  })

  it('places visible parents after their children and prevents self references', () => {
    const visibleIndexById = new Map(revisions.map((revision, index) => [revision.id, index]))

    for (const [childIndex, revision] of revisions.entries()) {
      for (const parentId of revision.parentIds ?? []) {
        expect(parentId).not.toBe(revision.id)

        const parentIndex = visibleIndexById.get(parentId)
        if (parentIndex !== undefined) {
          expect(parentIndex, `${revision.shortId} must appear before its visible parent`).toBeGreaterThan(childIndex)
        }
      }
    }
  })
})
