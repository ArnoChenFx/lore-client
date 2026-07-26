import { describe, expect, it } from 'vitest'

import { resolveMetadataRequest } from './MetadataBrowserPanel'

describe('metadata browser request resolution', () => {
  it('loads repository metadata without leaking unrelated drafts', () => {
    expect(resolveMetadataRequest('repository', 'main', 'revision-a')).toEqual({
      scope: 'repository'
    })
  })

  it('requires a concrete branch and trims the selected name', () => {
    expect(resolveMetadataRequest('branch', '  main  ', 'revision-a')).toEqual({
      scope: 'branch',
      target: 'main'
    })
    expect(resolveMetadataRequest('branch', '   ', 'revision-a')).toBeNull()
  })

  it('uses the newly selected revision instead of a stale revision draft', () => {
    expect(resolveMetadataRequest('revision', 'revision-b', 'revision-a')).toEqual({
      scope: 'revision',
      target: 'revision-b',
      revision: 'revision-b'
    })
  })

  it('waits for a file path and preserves its optional revision context', () => {
    expect(resolveMetadataRequest('file', ' Content/World.umap ', ' revision-a ')).toEqual({
      scope: 'file',
      target: 'Content/World.umap',
      revision: 'revision-a'
    })
    expect(resolveMetadataRequest('file', '   ', 'revision-a')).toBeNull()
  })
})
