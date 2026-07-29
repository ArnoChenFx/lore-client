import { describe, expect, it, vi } from 'vitest'

import type { ChangeFile, RepositorySnapshot } from '../../types'
import { runRepositoryMutationLifecycle } from './runRepositoryMutation'

function snapshot(conflict = false): RepositorySnapshot {
  const conflictFile: ChangeFile = {
    id: 'conflict-file',
    name: 'file.ts',
    path: 'src',
    status: 'modified',
    staged: false,
    additions: 0,
    deletions: 0,
    conflict,
    conflictUnresolved: conflict
  }
  return {
    repository: {
      id: 'repository',
      name: 'Repository',
      path: 'C:/repository',
      branch: 'main',
      revision: conflict ? 'revision-2' : 'revision-1',
      ahead: 0,
      behind: 0,
      online: true,
      remoteState: 'online',
      color: '#000000',
      conflictCount: conflict ? 1 : 0,
      unresolvedConflictCount: conflict ? 1 : 0
    },
    revisions: [],
    branches: [],
    changes: conflict ? [conflictFile] : [],
    tags: [],
    conflictSession: conflict
      ? {
          kind: 'merge',
          currentRevision: 'revision-1',
          stagedRevision: 'staged-revision',
          incomingRevision: 'revision-2'
        }
      : null,
    loadedAt: '2026-07-26T00:00:00.000Z'
  }
}

function dependencies() {
  return {
    applySnapshot: vi.fn(),
    selectView: vi.fn(),
    focusConflictFile: vi.fn(),
    conflictTitle: vi.fn(() => 'Merge conflict'),
    notify: vi.fn(),
    beginOperation: vi.fn(() => ({ id: 1, startedAt: 0 })),
    finishOperation: vi.fn()
  }
}

describe('repository mutation lifecycle', () => {
  it('refreshes the snapshot and reports a normal successful mutation', async () => {
    const before = snapshot()
    const after = { ...snapshot(), loadedAt: '2026-07-26T00:01:00.000Z' }
    const callbacks = dependencies()

    const result = await runRepositoryMutationLifecycle({
      activeSnapshot: before,
      labelKey: 'sync',
      task: vi.fn(async () => undefined),
      successDetail: 'Repository synchronized',
      loadSnapshot: vi.fn(async () => after),
      nextView: 'changes',
      ...callbacks
    })

    expect(result).toBe(true)
    expect(callbacks.applySnapshot).toHaveBeenCalledWith(after)
    expect(callbacks.selectView).toHaveBeenCalledWith('changes')
    expect(callbacks.finishOperation).toHaveBeenCalledWith({ id: 1, startedAt: 0 }, true, {
      kind: 'text',
      text: 'Repository synchronized'
    })
  })

  it('projects a lightweight mutation result without loading the full repository snapshot', async () => {
    const before = snapshot()
    const projected = {
      ...before,
      repository: { ...before.repository, identity: 'Updated Author' },
      loadedAt: '2026-07-26T00:00:30.000Z'
    }
    const callbacks = dependencies()
    const loadSnapshot = vi.fn(async () => {
      throw new Error('Full snapshot should not load')
    })

    const result = await runRepositoryMutationLifecycle({
      activeSnapshot: before,
      labelKey: 'updateRepositoryConfiguration',
      task: vi.fn(async () => ({ identity: 'Updated Author' })),
      projectSnapshot: (_activeSnapshot, mutationResult) => {
        expect(mutationResult).toEqual({ identity: 'Updated Author' })
        return projected
      },
      successDetail: 'Configuration saved',
      loadSnapshot,
      ...callbacks
    })

    expect(result).toBe(true)
    expect(loadSnapshot).not.toHaveBeenCalled()
    expect(callbacks.applySnapshot).toHaveBeenCalledWith(projected)
  })

  it('focuses a newly created conflict instead of reporting ordinary success', async () => {
    const before = snapshot()
    const after = snapshot(true)
    const callbacks = dependencies()

    const result = await runRepositoryMutationLifecycle({
      activeSnapshot: before,
      labelKey: 'mergeBranch',
      task: vi.fn(async () => undefined),
      successDetail: 'Merged',
      loadSnapshot: vi.fn(async () => after),
      ...callbacks
    })

    expect(result).toBe(true)
    expect(callbacks.focusConflictFile).toHaveBeenCalledWith(after.changes[0])
    expect(callbacks.notify).toHaveBeenCalledWith('Merge conflict', expect.any(String), 'warning')
    expect(callbacks.finishOperation).toHaveBeenCalledWith(
      { id: 1, startedAt: 0 },
      true,
      expect.objectContaining({ kind: 'i18n', key: 'status.conflictFilesNeedResolution' })
    )
  })

  it('tries to refresh partial state after a failed mutation and preserves the original error', async () => {
    const before = snapshot()
    const recovered = { ...snapshot(), loadedAt: '2026-07-26T00:02:00.000Z' }
    const callbacks = dependencies()

    const result = await runRepositoryMutationLifecycle({
      activeSnapshot: before,
      labelKey: 'push',
      task: vi.fn(async () => {
        throw new Error('Push failed')
      }),
      successDetail: 'Pushed',
      loadSnapshot: vi.fn(async () => recovered),
      ...callbacks
    })

    expect(result).toBe(false)
    expect(callbacks.applySnapshot).toHaveBeenCalledWith(recovered)
    expect(callbacks.notify).toHaveBeenCalledWith(expect.any(String), 'Push failed', 'warning')
    expect(callbacks.finishOperation).toHaveBeenCalledWith({ id: 1, startedAt: 0 }, false, 'Push failed')
  })
})
