import { describe, expect, it } from 'vitest'

import type { Branch, Revision } from '../../types'
import { resolveRevisionCheckoutBranch } from './revisionCheckoutTarget'

const revision = (id: string, parentIds: string[]): Revision =>
  ({
    id,
    shortId: id,
    title: id,
    description: id,
    author: 'Arno',
    initials: 'A',
    timestamp: '',
    relativeTime: '',
    branchPointers: [],
    parentCount: parentIds.length,
    parentIds,
    filesChanged: 0,
    additions: 0,
    deletions: 0,
    size: '—'
  }) satisfies Revision

describe('Revision checkout target branch', () => {
  const revisions = [
    revision('merge', ['main-2', 'vv-2']),
    revision('main-2', ['root']),
    revision('vv-2', ['vv-1']),
    revision('vv-1', ['root']),
    revision('root', [])
  ]
  const branches = [
    {
      id: 'local:main-id',
      name: 'main',
      latest: 'merge',
      current: true,
      remote: false,
      branchPoints: []
    },
    {
      id: 'local:vv-id',
      name: 'vv',
      latest: 'vv-2',
      current: false,
      remote: false,
      branchPoints: [{ branch: 'main-id', revision: 'root' }]
    }
  ] satisfies Branch[]

  it('keeps a mainline Revision attached to the current main branch', () => {
    expect(resolveRevisionCheckoutBranch(revisions[1]!, branches, revisions, 'main')).toBe('main')
  })

  it('checks out a merged side Revision through its actual vv branch', () => {
    expect(resolveRevisionCheckoutBranch(revisions[2]!, branches, revisions, 'main')).toBe('vv')
  })

  it('prefers the current branch at a shared branch point', () => {
    expect(resolveRevisionCheckoutBranch(revisions[4]!, branches, revisions, 'main')).toBe('main')
  })
})
