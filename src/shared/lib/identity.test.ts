import { describe, expect, it } from 'bun:test'

import { formatCommitIdentity, parseCommitIdentity, shouldDisplayRevisionAuthorEmail } from './identity'

describe('Lore commit identity compatibility', () => {
  it('encodes a separate author and email into the single identity field used by Lore', () => {
    expect(formatCommitIdentity(' YourName ', ' yourname@example.com ')).toBe('YourName <yourname@example.com>')
  })

  it('parses a Git-style identity into separate author text and Gravatar email', () => {
    expect(parseCommitIdentity('YourName <yourname@Example.com>')).toMatchObject({
      name: 'YourName',
      email: 'yourname@Example.com'
    })
  })

  it('supports email-only and free-form identities from legacy repositories', () => {
    expect(parseCommitIdentity('legacy@example.com')).toMatchObject({ name: '', email: 'legacy@example.com' })
    expect(parseCommitIdentity('Art Team')).toEqual({ name: 'Art Team', email: '', raw: 'Art Team' })
  })

  it('shows a separate email line only when the author also has a distinct name', () => {
    expect(shouldDisplayRevisionAuthorEmail('YourName', 'yourname@example.com')).toBe(true)
    expect(shouldDisplayRevisionAuthorEmail('legacy@example.com', 'legacy@example.com')).toBe(false)
    expect(shouldDisplayRevisionAuthorEmail('Art Team')).toBe(false)
  })
})
