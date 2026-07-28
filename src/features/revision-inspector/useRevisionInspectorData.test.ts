import { describe, expect, it } from 'vitest'

import type { ChangeFile, Revision, RevisionFile } from '../../types'
import {
  isRevisionDiffRequestCurrent,
  projectRevisionInspector,
  revisionInspectorRetention
} from './useRevisionInspectorData'

const revision: Revision = {
  id: 'revision-2',
  shortId: 'revision',
  title: 'Current revision',
  description: 'Projection fixture',
  author: 'Author',
  initials: 'AU',
  timestamp: '2026-07-26T00:00:00.000Z',
  relativeTime: 'now',
  branchPointers: [],
  parentCount: 1,
  parentIds: ['revision-1'],
  filesChanged: 7,
  additions: 10,
  deletions: 4,
  size: '1 KB'
}

const change: ChangeFile = {
  id: 'change-1',
  name: 'file.ts',
  path: 'src',
  status: 'modified',
  staged: false,
  additions: 3,
  deletions: 2
}

const treeFile: RevisionFile = {
  id: 'tree-1',
  name: 'file.ts',
  path: 'src',
  size: '1 KB',
  binary: false
}

describe('revision inspector projection', () => {
  it('rejects a diff request retained from another repository tab', () => {
    expect(
      isRevisionDiffRequestCurrent({
        repositoryPath: 'E:\\Repos\\current',
        selectedRevisionId: 'revision-2',
        loadedRepositoryPath: 'E:\\Repos\\previous',
        loadedRevisionId: 'revision-2',
        primaryPath: 'src/file.ts',
        primaryFileBinary: false
      })
    ).toBe(false)
    expect(
      isRevisionDiffRequestCurrent({
        repositoryPath: 'E:\\Repos\\current',
        selectedRevisionId: 'revision-2',
        loadedRepositoryPath: 'E:\\Repos\\current',
        loadedRevisionId: 'revision-2',
        primaryPath: 'src/file.ts',
        primaryFileBinary: false
      })
    ).toBe(true)
    expect(
      isRevisionDiffRequestCurrent({
        repositoryPath: 'E:\\Repos\\current',
        selectedRevisionId: 'revision-2',
        loadedRepositoryPath: 'E:\\Repos\\current',
        loadedRevisionId: 'revision-2',
        primaryPath: 'Content/texture.png',
        primaryFileBinary: true
      })
    ).toBe(false)
  })

  it('releases large resources when their inspector tab is inactive', () => {
    expect(revisionInspectorRetention('overview')).toEqual({ changes: false, files: false })
    expect(revisionInspectorRetention('changes')).toEqual({ changes: true, files: false })
    expect(revisionInspectorRetention('tree')).toEqual({ changes: false, files: true })
  })

  it('hides stale async results from a previously selected revision', () => {
    const projection = projectRevisionInspector({
      applicationMode: 'tauri',
      selectedRevision: revision,
      demoRevisionFiles: [],
      revisionChanges: [change],
      revisionChangesRevisionId: 'revision-1',
      revisionFiles: [treeFile],
      revisionFilesRevisionId: 'revision-1'
    })

    expect(projection.visibleInspectorFiles).toEqual([])
    expect(projection.visibleRevisionFiles).toEqual([])
    expect(projection.revisionTreeReady).toBe(false)
    expect(projection.inspectorRevision).toBe(revision)
  })

  it('updates only the loaded file count for real lightweight changes', () => {
    const projection = projectRevisionInspector({
      applicationMode: 'tauri',
      selectedRevision: revision,
      demoRevisionFiles: [],
      revisionChanges: [change],
      revisionChangesRevisionId: revision.id,
      revisionFiles: [treeFile],
      revisionFilesRevisionId: revision.id
    })

    expect(projection.inspectorRevision).toEqual({
      ...revision,
      filesChanged: 1
    })
    expect(projection.inspectorRevision?.additions).toBe(10)
    expect(projection.inspectorRevision?.deletions).toBe(4)
    expect(projection.revisionTreeReady).toBe(true)
  })

  it('derives demo summaries and immutable tree rows from fixture changes', () => {
    const projection = projectRevisionInspector({
      applicationMode: 'browser-demo',
      selectedRevision: revision,
      demoRevisionFiles: [change],
      revisionChanges: [],
      revisionChangesRevisionId: '',
      revisionFiles: [],
      revisionFilesRevisionId: ''
    })

    expect(projection.inspectorRevision).toEqual({
      ...revision,
      filesChanged: 1,
      additions: 3,
      deletions: 2
    })
    expect(projection.visibleRevisionFiles).toEqual([
      {
        id: 'revision-tree-change-1',
        name: 'file.ts',
        path: 'src',
        size: '—',
        binary: false
      }
    ])
  })
})
