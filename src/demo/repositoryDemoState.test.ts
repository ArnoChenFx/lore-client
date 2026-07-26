import { describe, expect, it } from 'vitest'

import { initialChanges, inspectorFiles, revisions } from './repositoryData'
import { getDemoInspectorFiles, setEveryDemoFileStaged, toggleDemoFileStage } from './repositoryDemoState'

describe('demo stage state transitions', () => {
  it('toggles only the target file without mutating the input', () => {
    const target = initialChanges[0]
    const next = toggleDemoFileStage(initialChanges, target.id)

    expect(next[0].staged).toBe(!target.staged)
    expect(initialChanges[0].staged).toBe(target.staged)
    expect(next[1]).toBe(initialChanges[1])
  })

  it('creates a new object for every file during bulk staging', () => {
    const next = setEveryDemoFileStaged(initialChanges, true)

    expect(next.every((file) => file.staged)).toBe(true)
    expect(next[0]).not.toBe(initialChanges[0])
  })
})

describe('demo inspector file projection', () => {
  it('returns a stable projection bounded by the source file count', () => {
    const first = getDemoInspectorFiles(revisions[0], inspectorFiles)
    const second = getDemoInspectorFiles(revisions[0], inspectorFiles)

    expect(first).toEqual(second)
    expect(first.length).toBeGreaterThanOrEqual(2)
    expect(first.length).toBeLessThanOrEqual(inspectorFiles.length)
  })
})
