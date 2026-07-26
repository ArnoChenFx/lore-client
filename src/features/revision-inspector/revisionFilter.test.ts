import { describe, expect, it } from 'vitest'

import { revisions } from '../../demo'
import { filterRevisions } from './revisionFilter'

describe('revision filtering', () => {
  it('searches by author, hash, and branch label', () => {
    expect(filterRevisions(revisions, revisions[0].author).length).toBeGreaterThan(0)
    expect(filterRevisions(revisions, 'c7f3a81d')).toHaveLength(1)
    expect(filterRevisions(revisions, 'cinematic/prologue')).toHaveLength(1)
  })

  it('preserves the original list reference for a blank query', () => {
    expect(filterRevisions(revisions, '   ')).toBe(revisions)
  })
})
