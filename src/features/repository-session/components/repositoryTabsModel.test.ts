import { describe, expect, it } from 'vitest'

import type { Repository } from '../../../types'
import {
  reorderItemsById,
  resolveRepositoryTabPresentation,
  updateRepositoryTabCustomizations
} from './repositoryTabsModel'

interface TestItem {
  id: string
}

const readId = (item: TestItem) => item.id

const repository: Repository = {
  id: 'repository-id',
  name: 'lore-world',
  branch: 'main',
  revision: 'revision-id',
  path: 'E:\\Worlds\\Lore',
  ahead: 0,
  behind: 0,
  online: true,
  remoteState: 'online',
  color: '#78a4ff',
  conflictCount: 0,
  unresolvedConflictCount: 0
}

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

  it('applies a custom name, color, and icon by case-insensitive repository path', () => {
    const presentation = resolveRepositoryTabPresentation(repository, [
      {
        repositoryPath: 'e:\\worlds\\lore',
        name: 'Environment',
        color: '#e47a3f',
        icon: 'gamepad'
      }
    ])

    expect(presentation).toEqual({
      displayName: 'Environment',
      displayColor: '#e47a3f',
      displayIcon: 'gamepad',
      hasCustomName: true,
      hasCustomColor: true,
      hasCustomIcon: true
    })
  })

  it('removes the customization after all fields return to repository defaults', () => {
    const customized = updateRepositoryTabCustomizations([], repository, {
      name: 'Environment',
      color: '#4aa7ad',
      icon: 'code'
    })
    const nameRestored = updateRepositoryTabCustomizations(customized, repository, { name: null })
    const colorRestored = updateRepositoryTabCustomizations(nameRestored, repository, { color: null })
    const allRestored = updateRepositoryTabCustomizations(colorRestored, repository, { icon: null })

    expect(nameRestored).toEqual([{ repositoryPath: repository.path, color: '#4aa7ad', icon: 'code' }])
    expect(colorRestored).toEqual([{ repositoryPath: repository.path, icon: 'code' }])
    expect(allRestored).toEqual([])
  })

  it('rejects arbitrary colors and reuses the original list when nothing changes', () => {
    const customizations = [{ repositoryPath: repository.path, name: 'Environment' }]

    expect(updateRepositoryTabCustomizations(customizations, repository, { color: 'hotpink' })).toBe(customizations)
  })

  it('uses the default icon when no icon customization exists', () => {
    expect(resolveRepositoryTabPresentation(repository, [])).toMatchObject({
      displayIcon: 'boxes',
      hasCustomIcon: false
    })
  })
})
