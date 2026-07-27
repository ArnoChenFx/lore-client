import { beforeEach, describe, expect, it, vi } from 'vitest'

const getVersionMock = vi.fn<() => Promise<string>>()
const logWarningMock = vi.fn()

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: getVersionMock
}))
vi.mock('../services/logging', () => ({
  logWarning: logWarningMock
}))

import { loadApplicationVersion } from './appVersion'

describe('application version loader', () => {
  beforeEach(() => {
    getVersionMock.mockReset()
    logWarningMock.mockReset()
  })

  it('returns the trimmed version reported by Tauri', async () => {
    getVersionMock.mockResolvedValue(' 0.1.2 ')

    await expect(loadApplicationVersion()).resolves.toBe('0.1.2')
  })

  it('returns null when the native app API is unavailable', async () => {
    const error = new Error('native API unavailable')
    getVersionMock.mockRejectedValue(error)

    await expect(loadApplicationVersion()).resolves.toBeNull()
    expect(logWarningMock).toHaveBeenCalledWith('application-version', error)
  })
})
