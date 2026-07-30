import { describe, expect, it } from 'vitest'

import type { ChangeFile, WorkingTreeDiff } from '../../types'
import { repositoryFileContentKind, resolvedDiffContentKind, shouldLoadRepositoryTextDiff } from './fileContent'

const createFile = (overrides: Partial<ChangeFile> = {}): ChangeFile => ({
  id: 'file-1',
  path: 'content-without-extension',
  name: 'content-without-extension',
  status: 'modified',
  staged: false,
  additions: 0,
  deletions: 0,
  ...overrides
})

describe('file content classification helpers', () => {
  it('prefers structured classification over the legacy binary flag', () => {
    const file = createFile({
      binary: true,
      contentClassification: { kind: 'unknown', source: 'deferred' }
    })

    expect(repositoryFileContentKind(file)).toBe('unknown')
  })

  it('uses the Lore diff marker after a deferred list classification', () => {
    const file = createFile({
      contentClassification: { kind: 'unknown', source: 'deferred' }
    })
    const diff: WorkingTreeDiff = {
      path: file.path,
      patch: 'Binary files differ',
      action: 'modify',
      contentClassification: { kind: 'binary', source: 'loreDiff' }
    }

    expect(resolvedDiffContentKind(file, diff)).toBe('binary')
  })

  it('keeps the legacy boolean as a compatibility fallback only', () => {
    expect(repositoryFileContentKind(createFile({ binary: false }))).toBe('text')
    expect(repositoryFileContentKind(createFile({ binary: true }))).toBe('binary')
    expect(repositoryFileContentKind(createFile())).toBe('unknown')
  })

  it('prefers bounded asset previews over full text diffs for model files', () => {
    const textModel = createFile({
      name: 'sphere.obj',
      contentClassification: { kind: 'text', source: 'utf8' }
    })
    const deferredModel = createFile({
      name: 'sphere.obj',
      contentClassification: { kind: 'unknown', source: 'deferred' }
    })
    const csv = createFile({
      name: 'metrics.csv',
      contentClassification: { kind: 'text', source: 'utf8' }
    })

    expect(shouldLoadRepositoryTextDiff(textModel, 'Models/sphere.obj')).toBe(false)
    expect(shouldLoadRepositoryTextDiff(deferredModel, 'Models/sphere.obj')).toBe(false)
    expect(shouldLoadRepositoryTextDiff(csv, 'Data/metrics.csv')).toBe(true)
  })
})
