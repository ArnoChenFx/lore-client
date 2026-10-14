import { describe, expect, it } from 'bun:test'

import { formatBytes } from './formatBytes'

describe('formatBytes', () => {
  it('uses binary units with one decimal above bytes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1_536)).toBe('1.5 KB')
    expect(formatBytes(1_024 ** 2)).toBe('1.0 MB')
    expect(formatBytes(10 * 1_024 ** 3)).toBe('10.0 GB')
    expect(formatBytes(1_024 ** 6)).toBe('1048576.0 TB')
  })

  it('never produces an unknown unit for values below one byte', () => {
    // 平滑后的速率可以衰减到 1 B/s 以下；不设下限时对数为负，会取到不存在的单位。
    expect(formatBytes(0.5)).toMatch(/^\d+ B$/)
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-3)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })
})
