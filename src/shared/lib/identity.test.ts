import { describe, expect, it } from 'vitest'

import {
  formatCommitIdentity,
  parseCommitIdentity,
  revisionAuthorFromIdentity,
  shouldDisplayRevisionAuthorEmail
} from './identity'

describe('Lore commit identity compatibility', () => {
  it('encodes a separate author and email into the single identity field used by Lore', () => {
    expect(formatCommitIdentity(' YourName ', ' yourname@example.com ')).toBe('YourName <yourname@example.com>')
  })

  it('parses a Git-style identity into separate author text and Gravatar email', () => {
    expect(revisionAuthorFromIdentity('YourName <yourname@Example.com>')).toEqual({
      author: 'YourName',
      email: 'yourname@Example.com'
    })
  })

  it('supports email-only and free-form identities from legacy repositories', () => {
    expect(parseCommitIdentity('legacy@example.com')).toMatchObject({ name: '', email: 'legacy@example.com' })
    expect(revisionAuthorFromIdentity('legacy@example.com')).toEqual({
      author: 'legacy@example.com',
      email: 'legacy@example.com'
    })
    expect(revisionAuthorFromIdentity('Art Team')).toEqual({ author: 'Art Team', email: undefined })
  })

  it('shows a separate email line only when the author also has a distinct name', () => {
    expect(shouldDisplayRevisionAuthorEmail('YourName', 'yourname@example.com')).toBe(true)
    expect(shouldDisplayRevisionAuthorEmail('legacy@example.com', 'legacy@example.com')).toBe(false)
    expect(shouldDisplayRevisionAuthorEmail('Art Team')).toBe(false)
  })
})
