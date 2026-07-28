import { describe, expect, it } from 'vitest'

import { shouldUseBrowserRemoteAuthenticationFixture } from './remoteAuthenticationFixture'

describe('browser remote authentication fixture', () => {
  it('requires both browser demo mode and the explicit query parameter', () => {
    expect(shouldUseBrowserRemoteAuthenticationFixture('browser-demo', '?remote-authentication-fixture=1')).toBe(true)
    expect(shouldUseBrowserRemoteAuthenticationFixture('browser-demo', '')).toBe(false)
    expect(shouldUseBrowserRemoteAuthenticationFixture('tauri', '?remote-authentication-fixture=1')).toBe(false)
  })
})
