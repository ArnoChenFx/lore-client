import { describe, expect, it } from 'bun:test'

import i18n from '../../i18n'
import type { Revision } from '../../types'
import { revisionPresentation } from './revisionPresentation'

const committedAt = Date.UTC(2026, 9, 20, 12)
const revision: Revision = {
  id: 'abcdef1234567890',
  shortId: 'abcdef12',
  title: '',
  revisionNumber: 12,
  committedAt,
  author: '',
  initials: '',
  branchPointers: [],
  parentCount: 0,
  parentIds: [],
  filesChanged: 0,
  additions: 0,
  deletions: 0
}
const english = i18n.getFixedT('en-US')
const chinese = i18n.getFixedT('zh-CN')

describe('revision presentation', () => {
  it('renders the same loaded facts in the active language without mutating the DTO', () => {
    const before = structuredClone(revision)
    const en = revisionPresentation(revision, english, committedAt + 5 * 60_000)
    const zh = revisionPresentation(revision, chinese, committedAt + 5 * 60_000)

    expect(en.relativeTime).toBe('5 minutes ago')
    expect(zh.relativeTime).toBe('5 分钟前')
    expect(en.author).toBe('Unknown author')
    expect(zh.author).toBe('未知作者')
    expect(en.description).toBe(english('status.revisionLabel', { number: 12, id: 'abcdef12' }))
    expect(zh.description).toBe(chinese('status.revisionLabel', { number: 12, id: 'abcdef12' }))
    expect(en.title).toBe(en.description)
    expect(zh.title).toBe(zh.description)
    expect(en.dateTime).toBe('2026-10-20T12:00:00.000Z')
    expect(revision).toEqual(before)
  })

  it('advances relative time from current time without reloading history', () => {
    expect(revisionPresentation(revision, english, committedAt + 59 * 60_000).relativeTime).toBe('59 minutes ago')
    expect(revisionPresentation(revision, english, committedAt + 60 * 60_000).relativeTime).toBe('1 hour ago')
    expect(revisionPresentation(revision, chinese, committedAt + 24 * 60 * 60_000).relativeTime).toBe('1 天前')
  })

  it('localizes missing time and never slices its label into a malformed short date', () => {
    const unknown = { ...revision, committedAt: null }
    const en = revisionPresentation(unknown, english)
    const zh = revisionPresentation(unknown, chinese)

    expect(en.timestamp).toBe('Unknown time')
    expect(zh.timestamp).toBe('时间未知')
    expect(en.relativeTime).toBe(en.timestamp)
    expect(zh.relativeTime).toBe(zh.timestamp)
    expect(en.shortTimestamp).toBe('')
    expect(zh.shortTimestamp).toBe('')
    expect(en.dateTime).toBeUndefined()
  })

  it('preserves commit titles and historical author facts across languages', () => {
    const titled: Revision = {
      ...revision,
      title: 'Lighting pass',
      author: 'Art Team',
      initials: 'A'
    }
    for (const translate of [chinese, english]) {
      expect(revisionPresentation(titled, translate)).toMatchObject({
        title: 'Lighting pass',
        author: 'Art Team',
        initials: 'A'
      })
    }
  })
})
