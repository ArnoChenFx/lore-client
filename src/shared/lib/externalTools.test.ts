import { describe, expect, it } from 'vitest'

import type { ChangeFile } from '../../types'
import {
  createExternalMergeRequest,
  createRevisionExternalDiffRequest,
  createWorkspaceExternalDiffRequest,
  DEFAULT_EXTERNAL_DIFF_TOOLS,
  externalDiffToolPreset,
  isExternalDiffToolConfigured,
  isExternalToolConfigured,
  orderExternalTools
} from './externalTools'

const tool = externalDiffToolPreset('vscode')

function change(overrides: Partial<ChangeFile> = {}): ChangeFile {
  return {
    id: 'Content/World.txt',
    path: 'Content',
    name: 'World.txt',
    status: 'modified',
    staged: false,
    additions: 0,
    deletions: 0,
    binary: false,
    ...overrides
  }
}

describe('external diff configuration', () => {
  it('requires an executable and both path placeholders', () => {
    expect(isExternalDiffToolConfigured(tool)).toBe(true)
    expect(isExternalDiffToolConfigured({ ...tool, executable: '' })).toBe(false)
    expect(isExternalDiffToolConfigured({ ...tool, arguments: ['{before}'] })).toBe(false)
  })

  it('keeps multiple configured tools and orders the primary tool first', () => {
    const tools = DEFAULT_EXTERNAL_DIFF_TOOLS.map((candidate) => ({
      ...candidate,
      primary: candidate.kind === 'vscode'
    }))

    expect(orderExternalTools(tools).map((candidate) => candidate.kind)).toEqual([
      'vscode',
      'beyondCompare',
      'cursor',
      'p4merge',
      'meld'
    ])
  })

  it('requires all four placeholders for merge tools', () => {
    const mergeTool = {
      ...tool,
      arguments: ['{remote}', '{local}', '{base}', '{merged}']
    }
    expect(isExternalToolConfigured(mergeTool, 'merge')).toBe(true)
    expect(isExternalToolConfigured({ ...mergeTool, arguments: ['{local}', '{merged}'] }, 'merge')).toBe(false)
  })
})

describe('external merge mapping', () => {
  it('preserves exact conflict revisions and repository-relative output path', () => {
    const request = createExternalMergeRequest(
      'E:\\Lore',
      change(),
      {
        ...tool,
        arguments: ['{remote}', '{local}', '{base}', '{merged}']
      },
      'local123',
      'remote456',
      {
        base: 'Base',
        local: 'Local',
        remote: 'Remote',
        merged: 'Merged'
      }
    )

    expect(request).toMatchObject({
      repositoryPath: 'E:\\Lore',
      path: 'Content/World.txt',
      currentRevision: 'local123',
      incomingRevision: 'remote456'
    })
  })
})

describe('external diff side mapping', () => {
  it('uses the workspace file directly and materializes the anchored revision', () => {
    const request = createWorkspaceExternalDiffRequest('E:\\Lore', 'abc123', change(), tool, {
      before: 'Before',
      after: 'After'
    })

    expect(request.before).toEqual({
      kind: 'revision',
      path: 'Content/World.txt',
      revision: 'abc123',
      label: 'Before'
    })
    expect(request.after).toEqual({
      kind: 'workspace',
      path: 'Content/World.txt',
      label: 'After'
    })
  })

  it('uses explicit empty sides for added and deleted files', () => {
    const added = createWorkspaceExternalDiffRequest('E:\\Lore', 'abc123', change({ status: 'added' }), tool, {
      before: 'Empty',
      after: 'Workspace'
    })
    const deleted = createWorkspaceExternalDiffRequest('E:\\Lore', 'abc123', change({ status: 'deleted' }), tool, {
      before: 'Revision',
      after: 'Empty'
    })

    expect(added.before.kind).toBe('empty')
    expect(added.after.kind).toBe('workspace')
    expect(deleted.before.kind).toBe('revision')
    expect(deleted.after.kind).toBe('empty')
  })

  it('preserves the exact source path for a renamed revision file', () => {
    const request = createRevisionExternalDiffRequest(
      'E:\\Lore',
      'parent123',
      'target456',
      change({
        status: 'renamed',
        previousPath: 'Content/OldWorld.txt'
      }),
      tool,
      { before: 'Parent', after: 'Target' }
    )

    expect(request.before).toEqual({
      kind: 'revision',
      path: 'Content/OldWorld.txt',
      revision: 'parent123',
      label: 'Parent'
    })
    expect(request.after).toEqual({
      kind: 'revision',
      path: 'Content/World.txt',
      revision: 'target456',
      label: 'Target'
    })
  })

  it('compares a root revision against an empty file', () => {
    const request = createRevisionExternalDiffRequest('E:\\Lore', null, 'root123', change(), tool, {
      before: 'Empty',
      after: 'Root'
    })

    expect(request.before.kind).toBe('empty')
    expect(request.after).toMatchObject({ kind: 'revision', revision: 'root123' })
  })
})
