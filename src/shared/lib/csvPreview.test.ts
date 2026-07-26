import { describe, expect, it } from 'vitest'

import { parseCsvPreview } from './csvPreview'

describe('CSV preview parsing', () => {
  it('parses a comma-separated table and preserves the first row as header data', () => {
    const table = parseCsvPreview('name,value\nalpha,1\nbeta,2\n')
    expect(table.rows).toEqual([
      ['name', 'value'],
      ['alpha', '1'],
      ['beta', '2']
    ])
    expect(table.truncatedRows).toBe(false)
    expect(table.truncatedCols).toBe(false)
  })

  it('supports quoted fields, embedded commas, and escaped quotes', () => {
    const table = parseCsvPreview('title,note\n"Hello, world","She said ""hi"""\n')
    expect(table.rows).toEqual([
      ['title', 'note'],
      ['Hello, world', 'She said "hi"']
    ])
  })

  it('truncates rows and columns at the configured limits', () => {
    const table = parseCsvPreview('a,b,c,d\n1,2,3,4\n5,6,7,8\n', 2, 2)
    expect(table.rows).toEqual([
      ['a', 'b'],
      ['1', '2']
    ])
    expect(table.truncatedRows).toBe(true)
    expect(table.truncatedCols).toBe(true)
  })
})
