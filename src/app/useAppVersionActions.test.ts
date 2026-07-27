import { describe, expect, it } from 'vitest'

import type { Branch, LoreTag, Revision, TagCreationSource } from '../types'
import {
  INITIAL_VERSION_ACTION_STATE,
  resolveSidebarBranchRevisionId,
  versionActionStateReducer
} from './useAppVersionActions'

const source: TagCreationSource = {
  kind: 'workspace',
  branch: 'main',
  revision: 'revision-1'
}

const tag: LoreTag = {
  id: 'tag-1',
  name: 'release/1',
  branch: 'main',
  revision: 'revision-1',
  message: '',
  createdAt: 1,
  updatedAt: 1
}

describe('application version action state', () => {
  it('keeps tag creation and editing mutually exclusive', () => {
    const creating = versionActionStateReducer(INITIAL_VERSION_ACTION_STATE, {
      type: 'openTagCreate',
      source
    })
    const editing = versionActionStateReducer(creating, {
      type: 'openTagEdit',
      tag
    })

    expect(editing.tagCreateSource).toBeNull()
    expect(editing.editingTag).toBe(tag)
  })

  it('closes tag details atomically when editing begins', () => {
    const details = versionActionStateReducer(INITIAL_VERSION_ACTION_STATE, {
      type: 'showTagDetails',
      tag
    })
    const editing = versionActionStateReducer(details, {
      type: 'openTagEdit',
      tag
    })

    expect(editing.tagDetails).toBeNull()
    expect(editing.editingTag).toBe(tag)
  })

  it('closes both tag dialog modes with one transition', () => {
    const editing = versionActionStateReducer(INITIAL_VERSION_ACTION_STATE, {
      type: 'openTagEdit',
      tag
    })
    const closed = versionActionStateReducer(editing, { type: 'closeTagDialog' })

    expect(closed.tagCreateSource).toBeNull()
    expect(closed.editingTag).toBeNull()
  })

  it('resolves a sidebar branch only to its exact loaded latest revision', () => {
    const branch = { id: 'local:feature', name: 'feature', latest: 'revision-feature' } as Branch
    const revisions = [{ id: 'revision-main' }, { id: 'revision-feature' }] as Revision[]

    expect(resolveSidebarBranchRevisionId(branch, revisions)).toBe('revision-feature')
  })

  it('does not fall back when the branch latest revision is outside the loaded snapshot', () => {
    const branch = { id: 'remote:feature', name: 'feature', latest: 'revision-missing' } as Branch
    const revisions = [{ id: 'revision-main' }] as Revision[]

    expect(resolveSidebarBranchRevisionId(branch, revisions)).toBeUndefined()
  })
})
