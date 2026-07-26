import { describe, expect, it } from 'vitest'

import type { ChangeFile, LoreFileLock } from '../../../types'
import { canOpenChangeContextSubmenu, resolveChangeFileLockSelection } from './ChangeContextMenu'

describe('local change context submenu guards', () => {
  it('keeps external diff available for binary files and tool configuration', () => {
    expect(canOpenChangeContextSubmenu('external', { textFileCount: 0, busy: false })).toBe(true)
    expect(canOpenChangeContextSubmenu('external', { textFileCount: 2, busy: false })).toBe(true)
  })

  it('prevents opening the ignore submenu while busy', () => {
    expect(canOpenChangeContextSubmenu('ignore', { textFileCount: 1, busy: true })).toBe(false)
    expect(canOpenChangeContextSubmenu('ignore', { textFileCount: 1, busy: false })).toBe(true)
  })

  it('keeps the lock submenu available for status and manager access while writes are busy', () => {
    expect(canOpenChangeContextSubmenu('lock', { textFileCount: 0, busy: true })).toBe(true)
  })
})

describe('local change collaborative lock selection', () => {
  const files: ChangeFile[] = [
    {
      id: 'Content/Hero.uasset',
      path: 'Content',
      name: 'Hero.uasset',
      status: 'modified',
      staged: false,
      additions: 0,
      deletions: 0,
      binary: true
    },
    {
      id: 'Content/New.uasset',
      path: 'Content',
      name: 'New.uasset',
      status: 'added',
      staged: false,
      additions: 0,
      deletions: 0,
      binary: true
    },
    {
      id: 'Content/Removed.uasset',
      path: 'Content',
      name: 'Removed.uasset',
      status: 'deleted',
      staged: false,
      additions: 0,
      deletions: 0,
      binary: true
    }
  ]

  const locks: LoreFileLock[] = [
    {
      path: 'Content/Hero.uasset',
      branch: 'main',
      owner: 'artist-a',
      lockedAt: 1
    },
    {
      path: 'Content/Hero.uasset',
      branch: 'main',
      owner: 'artist-b',
      lockedAt: 2
    },
    {
      path: 'Other/Unselected.uasset',
      branch: 'main',
      owner: 'artist-c',
      lockedAt: 3
    }
  ]

  it('preserves every owner while separating locked, acquirable, and deleted paths', () => {
    const selection = resolveChangeFileLockSelection(files, locks)

    expect(selection.locks.map((lock) => lock.owner)).toEqual(['artist-a', 'artist-b'])
    expect(selection.lockedFiles.map((file) => file.name)).toEqual(['Hero.uasset'])
    expect(selection.acquirableFiles.map((file) => file.name)).toEqual(['New.uasset'])
    expect(selection.deletedUnlockedFiles.map((file) => file.name)).toEqual(['Removed.uasset'])
  })

  it('keeps an already locked deleted path releasable instead of treating it as acquirable', () => {
    const deletedLock: LoreFileLock = {
      path: 'Content/Removed.uasset',
      branch: 'main',
      owner: 'artist-a',
      lockedAt: 4
    }
    const selection = resolveChangeFileLockSelection([files[2]], [deletedLock])

    expect(selection.lockedFiles).toEqual([files[2]])
    expect(selection.acquirableFiles).toEqual([])
    expect(selection.deletedUnlockedFiles).toEqual([])
  })
})
