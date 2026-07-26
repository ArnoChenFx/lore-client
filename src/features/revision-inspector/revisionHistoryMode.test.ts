import { describe, expect, it } from 'vitest'

import type { Branch, Revision } from '../../types'
import {
  branchPointersForLaneMode,
  revisionHistoryQueryForLaneMode,
  revisionIdsAheadOfHead,
  revisionsForLaneMode
} from './revisionHistoryMode'

const repository = {
  branch: 'main',
  revision: 'main-tip'
}

const branches: Branch[] = [
  { id: 'local:main-id', name: 'main', latest: 'main-tip', current: true },
  { id: 'remote:published-main-id', name: 'main', latest: 'main-parent', remote: true },
  { id: 'local:feature-id', name: 'feature', latest: 'feature-tip' },
  { id: 'remote:published-feature-id', name: 'feature', latest: 'feature-tip', remote: true }
]

function createRevision(id: string, parentIds: string[]): Revision {
  return {
    id,
    shortId: id,
    title: id,
    description: '',
    author: '测试作者',
    initials: '测',
    timestamp: '2026-07-26 10:00',
    relativeTime: '刚刚',
    branchPointers: [],
    parentCount: parentIds.length,
    parentIds,
    filesChanged: 0,
    additions: 0,
    deletions: 0,
    size: '0 B'
  }
}

describe('Revision History lane mode', () => {
  it('forces the current Branch query and clears another Branch start in flat mode', () => {
    expect(
      revisionHistoryQueryForLaneMode(
        {
          branch: 'feature',
          revision: 'feature-tip',
          beforeDate: 123,
          onlyBranch: false,
          limit: 250
        },
        repository,
        'flat'
      )
    ).toEqual({
      branch: 'main',
      revision: undefined,
      beforeDate: 123,
      onlyBranch: true,
      limit: 250
    })
  })

  it('keeps only first-parent Revisions from the current Branch in flat mode', () => {
    const revisions = [
      createRevision('main-tip', ['main-parent', 'feature-tip']),
      createRevision('feature-tip', ['shared']),
      createRevision('main-parent', ['shared']),
      createRevision('shared', [])
    ]

    expect(revisionsForLaneMode(revisions, repository, branches, 'flat').map((revision) => revision.id)).toEqual([
      'main-tip',
      'main-parent',
      'shared'
    ])
    expect(revisionsForLaneMode(revisions, repository, branches, 'topology')).toBe(revisions)
  })

  it('keeps local, remote, and exact HEAD pointers for the current Branch in flat mode', () => {
    const pointers = [
      { id: 'local:main-id', name: 'main', kind: 'local' as const },
      { id: 'remote:published-main-id', name: 'main', kind: 'remote' as const },
      { id: 'local:feature-id', name: 'feature', kind: 'local' as const },
      { id: 'remote:published-feature-id', name: 'feature', kind: 'remote' as const },
      { id: 'head', name: 'HEAD', kind: 'head' as const }
    ]

    expect(branchPointersForLaneMode(pointers, repository, branches, 'flat')).toEqual([
      pointers[0],
      pointers[1],
      pointers[4]
    ])
    expect(branchPointersForLaneMode(pointers, repository, branches, 'topology')).toBe(pointers)
  })

  it('marks only Revisions ahead of the exact HEAD in the full history projection', () => {
    const revisions = [
      createRevision('latest', ['newer']),
      createRevision('newer', ['workspace-head']),
      createRevision('workspace-head', ['older']),
      createRevision('older', [])
    ]

    expect([...revisionIdsAheadOfHead(revisions, 'workspace-head')]).toEqual(['latest', 'newer'])
    expect(revisionIdsAheadOfHead(revisions, 'latest').size).toBe(0)
    expect(revisionIdsAheadOfHead(revisions, 'missing').size).toBe(0)
  })
})
