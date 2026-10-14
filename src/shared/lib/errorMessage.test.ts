import { describe, expect, it } from 'bun:test'

import { readErrorMessage } from './errorMessage'

describe('cross-boundary error messages', () => {
  it('preserves string errors rejected directly by a Tauri plugin', () => {
    expect(readErrorMessage('The patch target is locked by another process')).toBe(
      'The patch target is locked by another process'
    )
  })
})
