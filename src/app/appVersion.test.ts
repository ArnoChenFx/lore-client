import { beforeEach, describe, expect, it, vi } from 'vitest'

const getVersionMock = vi.fn<() => Promise<string>>()

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: getVersionMock
}))

import { loadApplicationVersion } from './appVersion'

describe('application version loader', () => {
  beforeEach(() => {
    getVersionMock.mockReset()
  })

  it('returns the trimmed version reported by Tauri', async () => {
    getVersionMock.mockResolvedValue(' 0.1.2 ')

    await expect(loadApplicationVersion()).resolves.toBe('0.1.2')
  })

  it('returns null when the native app API is unavailable', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    getVersionMock.mockRejectedValue(new Error('native API unavailable'))

    await expect(loadApplicationVersion()).resolves.toBeNull()
    expect(warning).toHaveBeenCalledOnce()
    warning.mockRestore()
  })
})
