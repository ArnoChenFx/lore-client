import { describe, expect, it } from 'bun:test'

import type { ChangeFile, LoreFileLock } from '../../../types'
import { canOpenChangeContextSubmenu, resolveChangeFileLockSelection, shouldOpenSubmenuUp } from './ChangeContextMenu'

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

describe('local change context submenu placement', () => {
  // 数值取自 1280×720 下菜单被夹到窗口底部时的真实测量：Ignore 触发行顶边约 575，四项子菜单高约 144
  // （中文单行），英文标签的实例级两项折成两行后约 158。视口留 8px 间距，向下展开的底边不得超过 712。
  it('keeps opening downward while there is room', () => {
    expect(shouldOpenSubmenuUp(100, 144, 720)).toBe(false)
    expect(shouldOpenSubmenuUp(568, 144, 720)).toBe(false)
  })

  it('opens upward when the Chinese submenu would press into the bottom gap', () => {
    // 向下展开后底边 714，虽然仍在 720 的视口内，却压进了 8px 间距。
    expect(shouldOpenSubmenuUp(575, 144, 720)).toBe(true)
  })

  it('opens upward when wrapped English labels would run past the viewport', () => {
    expect(shouldOpenSubmenuUp(585, 158, 720)).toBe(true)
  })

  it('treats the exact gap limit as still fitting', () => {
    // 575 - 5 + 142 = 712 恰好贴着间距边界；再高 1px 才需要翻转。
    expect(shouldOpenSubmenuUp(575, 142, 720)).toBe(false)
    expect(shouldOpenSubmenuUp(575, 143, 720)).toBe(true)
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
      contentClassification: { kind: 'binary', source: 'signature' }
    },
    {
      id: 'Content/New.uasset',
      path: 'Content',
      name: 'New.uasset',
      status: 'added',
      staged: false,
      additions: 0,
      deletions: 0,
      contentClassification: { kind: 'binary', source: 'signature' }
    },
    {
      id: 'Content/Removed.uasset',
      path: 'Content',
      name: 'Removed.uasset',
      status: 'deleted',
      staged: false,
      additions: 0,
      deletions: 0,
      contentClassification: { kind: 'binary', source: 'signature' }
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
