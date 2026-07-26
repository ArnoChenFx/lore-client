import { describe, expect, it } from 'vitest'

import type { ChangeFile } from '../../../types'
import {
  getChangeFileFullPath,
  getChangeFileRelativePath,
  revisionFileMenuCapabilities
} from './RevisionFileContextMenu'

const file: ChangeFile = {
  id: 'file-1',
  path: 'Content/World/Meridian',
  name: 'GoldenHour_Profile.uasset',
  status: 'modified',
  staged: false,
  additions: 12,
  deletions: 3
}

describe('revision file menu paths', () => {
  it('does not generate a Lore-rejected dot prefix for root files', () => {
    expect(
      getChangeFileRelativePath({
        ...file,
        path: '.',
        name: 'sda.txt'
      })
    ).toBe('sda.txt')
  })

  it('creates a Lore repository-relative path without a leading slash', () => {
    expect(getChangeFileRelativePath(file)).toBe('Content/World/Meridian/GoldenHour_Profile.uasset')
  })

  it('preserves Windows separators from the repository root', () => {
    expect(getChangeFileFullPath('E:\\Worlds\\Meridian\\', file)).toBe(
      'E:\\Worlds\\Meridian\\Content\\World\\Meridian\\GoldenHour_Profile.uasset'
    )
  })

  it('preserves Unix-like separators from the repository root', () => {
    expect(getChangeFileFullPath('/workspace/meridian/', file)).toBe(
      '/workspace/meridian/Content/World/Meridian/GoldenHour_Profile.uasset'
    )
  })

  it('keeps history and restore actions for unchanged files in the complete tree', () => {
    expect(
      revisionFileMenuCapabilities({
        source: 'tree',
        hasPrimaryChange: false,
        fileCount: 1
      })
    ).toEqual({
      canOpenChange: false,
      canShowInTree: false,
      canOpenHistory: true,
      canReset: true
    })
  })

  it('keeps change, locate, history, and restore actions in the changes view', () => {
    expect(
      revisionFileMenuCapabilities({
        source: 'changes',
        hasPrimaryChange: true,
        fileCount: 1
      })
    ).toEqual({
      canOpenChange: true,
      canShowInTree: true,
      canOpenHistory: true,
      canReset: true
    })
  })
})
