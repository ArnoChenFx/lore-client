import { describe, expect, it } from 'vitest'

import {
  isRepositoryAccentColor,
  REPOSITORY_ACCENT_PALETTE,
  REPOSITORY_TAB_COLOR_MATRIX,
  repositoryAccentFromIndex
} from './themeColors'

describe('repository tab color matrix', () => {
  it('provides five unique colors in each of five rows', () => {
    const colors = REPOSITORY_TAB_COLOR_MATRIX.flat()

    expect(REPOSITORY_TAB_COLOR_MATRIX).toHaveLength(5)
    expect(REPOSITORY_TAB_COLOR_MATRIX.every((row) => row.length === 5)).toBe(true)
    expect(new Set(colors).size).toBe(25)
    expect(colors.every(isRepositoryAccentColor)).toBe(true)
  })

  it('keeps every automatic color available without coupling it to a matrix column', () => {
    const colors = REPOSITORY_TAB_COLOR_MATRIX.flat()

    expect(REPOSITORY_ACCENT_PALETTE.every((color) => colors.includes(color))).toBe(true)
    expect(REPOSITORY_ACCENT_PALETTE.map((_, index) => repositoryAccentFromIndex(index))).toEqual(
      REPOSITORY_ACCENT_PALETTE
    )
  })

  it('rejects colors outside the controlled matrix', () => {
    expect(isRepositoryAccentColor('hotpink')).toBe(false)
  })
})
