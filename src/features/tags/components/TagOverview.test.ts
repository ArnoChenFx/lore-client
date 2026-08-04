import { describe, expect, it } from 'vitest'

import type { LoreTag } from '../../../types'
import { filterAndSortOverviewTags } from './TagOverview'

function createTag(id: string, name: string, message = ''): LoreTag {
  return {
    id,
    name,
    branch: 'main',
    revision: id,
    message,
    createdAt: 1,
    updatedAt: 1
  }
}

describe('tag overview sorting', () => {
  it('sorts tags folder-first at every path level without mutating input', () => {
    const tags = [
      createTag('tag:root', 'Alpha'),
      createTag('tag:release-zulu', 'release/zulu'),
      createTag('tag:preview', 'preview/Beta'),
      createTag('tag:release-api', 'release/api/candidate'),
      createTag('tag:release-alpha', 'release/alpha')
    ]

    expect(filterAndSortOverviewTags(tags, '').map((tag) => tag.name)).toEqual([
      'preview/Beta',
      'release/api/candidate',
      'release/alpha',
      'release/zulu',
      'Alpha'
    ])
    expect(tags.map((tag) => tag.name)).toEqual([
      'Alpha',
      'release/zulu',
      'preview/Beta',
      'release/api/candidate',
      'release/alpha'
    ])
  })

  it('keeps hierarchical sorting after filtering', () => {
    const tags = [
      createTag('tag:root', 'Alpha', 'stable'),
      createTag('tag:release-zulu', 'release/zulu', 'candidate'),
      createTag('tag:preview', 'preview/Beta', 'candidate'),
      createTag('tag:release-alpha', 'release/alpha', 'candidate')
    ]

    expect(filterAndSortOverviewTags(tags, 'candidate').map((tag) => tag.name)).toEqual([
      'preview/Beta',
      'release/alpha',
      'release/zulu'
    ])
  })
})
