import { describe, expect, it } from 'vitest'

import { sanitizeLogMessage } from './logging'

describe('application logging', () => {
  it('redacts credentials while preserving diagnostic context', () => {
    const message = sanitizeLogMessage(
      'request failed at C:\\repo\\game token="secret-value" Authorization: Bearer abc.def-123'
    )

    expect(message).toContain('C:\\repo\\game')
    expect(message).toContain('token="[REDACTED]"')
    expect(message).toContain('Bearer [REDACTED]')
    expect(message).not.toContain('secret-value')
    expect(message).not.toContain('abc.def-123')
  })

  it('redacts JWT values, URL credentials, and sensitive query parameters', () => {
    const message = sanitizeLogMessage(
      'https://alice:secret@example.com/api?access_token=top-secret jwt=eyJhbGciOiJIUzI1NiJ9.payload.signature'
    )

    expect(message).toContain('https://[REDACTED]@example.com')
    expect(message).toContain('access_token=[REDACTED]')
    expect(message).toContain('jwt=[REDACTED_JWT]')
    expect(message).not.toContain('alice')
    expect(message).not.toContain('top-secret')
  })

  it('bounds unexpectedly large error messages', () => {
    const message = sanitizeLogMessage('x'.repeat(5_000))

    expect(message.length).toBeLessThanOrEqual(4_012)
    expect(message.endsWith('…[TRUNCATED]')).toBe(true)
  })
})
