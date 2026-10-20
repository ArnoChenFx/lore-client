import { describe, expect, it } from 'bun:test'

import i18n from '../i18n'
import { revisionPresentation } from '../shared/lib'
import { revisions, tags } from './repositoryData'

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

describe('demo revision facts', () => {
  it('uses the same commit instants as the review tags', () => {
    for (const tag of tags) {
      const revision = revisions.find((item) => item.id === tag.revision)
      expect(revision?.committedAt).toBe(tag.createdAt)
    }
  })

  it('derives localized relative times from the fixed demo history', () => {
    const current = revisions[0]
    const merged = revisions[1]
    const english = i18n.getFixedT('en-US')
    const chinese = i18n.getFixedT('zh-CN')
    const now = current.committedAt!

    expect(revisionPresentation(current, english, now).relativeTime).toBe('Just now')
    expect(revisionPresentation(merged, english, now).relativeTime).toBe('39 minutes ago')
    expect(revisionPresentation(merged, chinese, now).relativeTime).toBe('39 分钟前')
    expect(revisionPresentation(merged, english, now + 24 * 60 * 60_000).relativeTime).toBe('1 day ago')
    expect(revisionPresentation(current, chinese, now).description).toBe(
      chinese('status.revisionLabel', { number: 12, id: current.shortId })
    )
  })
})
