import { parsePatchFiles } from '@pierre/diffs'
import { describe, expect, it } from 'vitest'

import type { ChangeFile } from '../../types'
import { createDemoWorkingTreeDiff } from './createDemoWorkingTreeDiff'

const demoFile: ChangeFile = {
  id: 'Config/render.json',
  path: 'Config',
  name: 'render.json',
  status: 'modified',
  staged: false,
  additions: 2,
  deletions: 2
}

describe('createDemoWorkingTreeDiff', () => {
  it('creates a parseable text patch for browser demo views', () => {
    const diff = createDemoWorkingTreeDiff(demoFile)
    const parsed = parsePatchFiles(diff.patch)[0]?.files[0]

    expect(diff).toMatchObject({ path: 'Config/render.json', action: 'modified' })
    expect(diff.patch).toContain('--- a/Config/render.json')
    expect(diff.patch).toContain('+++ b/Config/render.json')
    expect(parsed).toBeTruthy()
  })

  it('keeps binary demo files metadata-only', () => {
    expect(createDemoWorkingTreeDiff({ ...demoFile, binary: true })).toEqual({
      path: 'Config/render.json',
      patch: '',
      action: 'modified'
    })
  })
})
