import { describe, expect, it } from 'vitest'

import { reorderItemsById } from './repositoryTabsModel'

interface TestItem {
  id: string
}

const readId = (item: TestItem) => item.id

describe('repository tab ordering model', () => {
  it('places the source after the target when dragging left to right', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

    const reordered = reorderItemsById(items, 'a', 'c', readId)

    expect(reordered.map(readId)).toEqual(['b', 'c', 'a'])
  })

  it('places the source before the target when dragging right to left', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

    const reordered = reorderItemsById(items, 'c', 'a', readId)

    expect(reordered.map(readId)).toEqual(['c', 'a', 'b'])
  })

  it('preserves the original array for invalid or identical source and target IDs', () => {
    const items = [{ id: 'a' }, { id: 'b' }]

    expect(reorderItemsById(items, 'a', 'a', readId)).toBe(items)
    expect(reorderItemsById(items, 'missing', 'a', readId)).toBe(items)
    expect(reorderItemsById(items, 'a', 'missing', readId)).toBe(items)
  })
})
