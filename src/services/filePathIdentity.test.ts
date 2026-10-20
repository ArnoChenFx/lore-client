import { beforeEach, describe, expect, it, vi } from 'bun:test'

import { changeFileOperationPaths } from '../shared/lib'
import type { OperationContext } from '../types'

const invokeMock = vi.fn()
const tauriCore = await import('@tauri-apps/api/core')
vi.mock('@tauri-apps/api/core', () => ({ ...tauriCore, invoke: invokeMock, isTauri: () => true }))
const { queryFileLocks, loadFileLockStatus, acquireFileLocks, releaseFileLocks } = await import('./lore/locks')
const { loadBranchDiff } = await import('./lore/branches')
const { verifyRepositoryPath, dumpRepositoryState } = await import('./lore/diagnostics')
const { loadMetadata } = await import('./lore/metadata')
const { parseWorkingTreeDiffs, stagePaths, unstagePaths } = await import('./lore/workspace')
const { parseChanges } = await import('./lore/revisions')
const { createSharedStore } = await import('./lore/repositories')

const repositoryPath = '/tmp/project'

describe('file path identity at the IPC boundary', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockImplementation(async (command: string, args: { operationContext: OperationContext }) => ({
      ...args.operationContext,
      operation: command,
      status: 0,
      durationMs: 0,
      events: []
    }))
  })

  for (const path of ['asset ', ' asset', ' ']) {
    it(`preserves the exact optional path ${JSON.stringify(path)} instead of widening a query`, async () => {
      await queryFileLocks(repositoryPath, 'main', ' owner ', path)
      await loadBranchDiff(repositoryPath, 'source', 'target', path)
      await verifyRepositoryPath(repositoryPath, path, true)
      await dumpRepositoryState(repositoryPath, '', path, 2)
      await loadMetadata(repositoryPath, 'file', path)

      expect(invokeMock.mock.calls.map(([command, args]) => [command, args.path ?? args.target])).toEqual([
        ['lore_lock_file_query', path],
        ['lore_branch_diff', path],
        ['lore_repository_verify', path],
        ['lore_repository_dump', path],
        ['lore_metadata_list', path]
      ])
      expect(invokeMock.mock.calls[0][1].owner).toBe('owner')
    })
  }

  it('uses only an empty optional path for the existing unfiltered query semantics', async () => {
    await queryFileLocks(repositoryPath, 'main', undefined, '')
    await loadBranchDiff(repositoryPath, 'source', 'target', '')
    await verifyRepositoryPath(repositoryPath, '')
    await dumpRepositoryState(repositoryPath, '', '', 2)
    expect(invokeMock.mock.calls.map(([, args]) => args.path)).toEqual([null, null, null, null])
  })

  it('keeps distinct selected files through lock status, acquisition, and release', async () => {
    const paths = ['asset', 'asset ', ' asset', ' ']
    await loadFileLockStatus(repositoryPath, 'main', paths)
    await acquireFileLocks(repositoryPath, 'main', paths)
    await releaseFileLocks(repositoryPath, 'main', paths)
    expect(invokeMock.mock.calls.map(([, args]) => args.paths)).toEqual([paths, paths, paths])
  })

  it('retains both exact rename paths from native status through stage and unstage', async () => {
    const diffs = parseWorkingTreeDiffs([
      {
        tagName: 'fileDiff',
        data: { path: 'asset', action: 'move', patch: 'move from asset \nmove to asset\n' }
      }
    ])
    expect(diffs[0].previousPath).toBe('asset ')
    const files = parseChanges([
      {
        tagName: 'repositoryStatusFile',
        data: {
          path: 'asset',
          fromPath: 'asset ',
          action: 'move',
          contentClassification: { kind: 'text', source: 'loreDiff' }
        }
      }
    ])
    const paths = changeFileOperationPaths(files)
    await stagePaths(repositoryPath, paths)
    await unstagePaths(repositoryPath, paths)
    expect(invokeMock.mock.calls.map(([, args]) => args.paths)).toEqual([
      ['asset ', 'asset'],
      ['asset ', 'asset']
    ])
  })

  it('preserves the chosen Shared Store parent directory', async () => {
    await createSharedStore('lore://localhost', '/tmp/store ', false)
    expect(invokeMock.mock.calls[0][1].parentPath).toBe('/tmp/store ')
  })
})
