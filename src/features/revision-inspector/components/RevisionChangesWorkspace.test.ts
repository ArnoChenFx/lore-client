import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'

import i18n from '../../../i18n'
import { updateClientPreferences } from '../../../services/preferences'
import type { ChangeFile, Revision } from '../../../types'
import {
  createDefaultRevisionChangeSelection,
  isRevisionWorkspaceSelectionRequestCurrent,
  RevisionChangesWorkspace
} from './RevisionChangesWorkspace'

describe('revision change default selection', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN')
    updateClientPreferences({ binaryDiffVisible: true, revisionChangesDiffVisible: true })
  })

  const firstChange: ChangeFile = {
    id: 'first-change',
    name: 'World.ts',
    path: 'Content',
    status: 'modified',
    staged: false,
    additions: 0,
    deletions: 0,
    binary: false
  }
  const treeFirstChange: ChangeFile = {
    ...firstChange,
    id: 'tree-first-change',
    name: 'Actor.ts',
    path: 'Actors'
  }

  it('selects the first changed file after a revision becomes ready', () => {
    expect(createDefaultRevisionChangeSelection([firstChange])).toEqual({
      selectedObjectIds: ['file:first-change'],
      primaryObjectId: 'file:first-change'
    })
  })

  it('keeps the selection empty when the revision has no changed files', () => {
    expect(createDefaultRevisionChangeSelection([])).toEqual({
      selectedObjectIds: [],
      primaryObjectId: ''
    })
  })

  it('selects the first rendered file in tree view instead of the flat input head', () => {
    expect(createDefaultRevisionChangeSelection([firstChange, treeFirstChange], 'tree')).toEqual({
      selectedObjectIds: ['file:tree-first-change'],
      primaryObjectId: 'file:tree-first-change'
    })
  })

  it('rejects a stale file reveal request after switching repositories', () => {
    const request = {
      nonce: 1,
      repositoryPath: 'E:\\Repos\\previous',
      revisionId: 'revision-1',
      fileIds: ['Content/World.txt'],
      primaryFileId: 'Content/World.txt'
    }

    expect(isRevisionWorkspaceSelectionRequestCurrent(request, 'E:\\Repos\\current', 'revision-1')).toBe(false)
    expect(isRevisionWorkspaceSelectionRequestCurrent(request, 'E:\\Repos\\previous', 'revision-1')).toBe(true)
  })

  it('uses a file icon for an empty text diff', () => {
    const revision: Revision = {
      id: 'revision-2',
      shortId: 'revision',
      title: 'Empty text diff',
      description: '',
      author: 'Author',
      initials: 'AU',
      timestamp: '2026-07-30T00:00:00.000Z',
      relativeTime: 'now',
      branchPointers: [],
      parentCount: 1,
      parentIds: ['revision-1'],
      filesChanged: 1,
      additions: 0,
      deletions: 0,
      size: '1 KB'
    }
    const html = renderToStaticMarkup(
      createElement(RevisionChangesWorkspace, {
        repositoryPath: 'E:\\Repos\\fixture',
        revision,
        files: [
          {
            ...firstChange,
            contentClassification: { kind: 'text', source: 'utf8' }
          }
        ],
        diffs: [],
        loading: false,
        error: null,
        onOpenContextMenu: () => undefined
      })
    )
    const emptyState = html.slice(html.indexOf('revision-diff-pane__empty'))

    expect(emptyState).toContain('没有可显示的文本差异')
    expect(emptyState).toContain('lucide-file-code-corner')
    expect(emptyState).not.toContain('lucide-binary')
  })

  it('keeps both Revision Diff areas empty while loading', () => {
    const revision: Revision = {
      id: 'revision-2',
      shortId: 'revision',
      title: 'Loading diff',
      description: '',
      author: 'Author',
      initials: 'AU',
      timestamp: '2026-07-30T00:00:00.000Z',
      relativeTime: 'now',
      branchPointers: [],
      parentCount: 1,
      parentIds: ['revision-1'],
      filesChanged: 1,
      additions: 0,
      deletions: 0,
      size: '1 KB'
    }
    const html = renderToStaticMarkup(
      createElement(RevisionChangesWorkspace, {
        repositoryPath: 'E:\\Repos\\fixture',
        revision,
        files: [],
        diffs: [],
        loading: true,
        error: null,
        diffLoading: true,
        onOpenContextMenu: () => undefined
      })
    )

    expect(html).toContain('revision-change-browser__list')
    expect(html).toContain('revision-diff-pane__header')
    expect(html).not.toContain('revision-change-browser__empty')
    expect(html).not.toContain('revision-diff-pane__empty')
    expect(html).not.toContain('正在读取 Revision Diff')
    expect(html).not.toContain('正在读取 Lore Revision Diff')
    expect(html).not.toContain('is-spinning')
  })
})
