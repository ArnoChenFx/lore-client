import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

import type { LoreOperationStreamRecord, OperationProgress, OperationRecord } from '../../types'
import {
  PROGRESS_STALL_MS,
  deriveProgressView,
  formatElapsed,
  nextProgressRate,
  parseOperationProgress,
  selectActiveProgressRecord,
  selectActiveOperationRecord
} from './operationProgress'
import { mergeLoreOperationStream } from './operationStream'

function progress(overrides: Partial<OperationProgress> = {}): OperationProgress {
  return { unit: 'files', current: 0, totalFinal: false, elapsedMs: 0, ...overrides }
}

function record(overrides: Partial<LoreOperationStreamRecord> = {}): LoreOperationStreamRecord {
  return {
    requestId: overrides.operationId ?? 'operation-1',
    workspaceKey: '/workspace/project',
    operationId: 'operation-1',
    operation: 'file.stage',
    phase: 'streaming',
    startedAt: 1_000,
    eventCount: 1,
    cancellable: false,
    ...overrides
  }
}

describe('parseOperationProgress', () => {
  it('accepts the normalized payload and drops unknown keys', () => {
    expect(
      parseOperationProgress({
        unit: 'bytes',
        current: 18_149_426,
        total: 169_144_370,
        totalFinal: true,
        files: 4_000,
        filesTotal: 4_003,
        elapsedMs: 304,
        patch: 'must not be retained'
      })
    ).toEqual({
      unit: 'bytes',
      current: 18_149_426,
      total: 169_144_370,
      totalFinal: true,
      files: 4_000,
      filesTotal: 4_003,
      bytes: undefined,
      bytesTotal: undefined,
      stepIndex: undefined,
      stepCount: undefined,
      elapsedMs: 304
    })
  })

  it('rejects legacy summaries and malformed numbers instead of guessing', () => {
    expect(parseOperationProgress(undefined)).toBeUndefined()
    expect(parseOperationProgress({ current: 4, total: 10 })).toBeUndefined()
    expect(parseOperationProgress({ unit: 'bytes', current: Number.NaN })).toBeUndefined()
    expect(parseOperationProgress({ unit: 'bytes', current: -1 })).toBeUndefined()
    expect(parseOperationProgress({ unit: 'lines', current: 1 })).toBeUndefined()
  })

  it('accepts every snapshot the Rust aggregator produced from a real 100k-file trace', () => {
    const lines = readFileSync(new URL('./fixtures/real-progress-snapshots.jsonl', import.meta.url), 'utf8')
      .split('\n')
      .filter(Boolean)
    expect(lines.length).toBeGreaterThan(40)
    for (const line of lines) {
      const event = JSON.parse(line) as { tagName: string; data: Record<string, unknown> }
      expect(event.tagName).toMatch(/Progress$/)
      expect(parseOperationProgress(event.data), line).toBeDefined()
    }
  })
})

describe('deriveProgressView', () => {
  it('is indeterminate when the total is unknown (staging)', () => {
    const view = deriveProgressView(record({ progress: progress({ current: 1_203 }), progressAt: 5_000 }), 5_000)
    expect(view).toMatchObject({ fraction: null, approximate: false, stalled: false })
  })

  it('stays indeterminate while the total is still growing, so the bar never runs backwards', () => {
    const growing = progress({ current: 4_953, total: 15_877, totalFinal: false })
    expect(deriveProgressView(record({ progress: growing, progressAt: 0 }), 0)).toMatchObject({
      fraction: null,
      approximate: true
    })
    const final = progress({ unit: 'bytes', current: 0, total: 371_371_006, totalFinal: true })
    expect(deriveProgressView(record({ progress: final, progressAt: 0 }), 0)?.fraction).toBe(0)
  })

  it('computes a clamped fraction once the total is final', () => {
    const half = progress({ unit: 'bytes', current: 50, total: 100, totalFinal: true })
    expect(deriveProgressView(record({ progress: half, progressAt: 0 }), 0)?.fraction).toBe(0.5)
    const over = progress({ unit: 'bytes', current: 120, total: 100, totalFinal: true })
    expect(deriveProgressView(record({ progress: over, progressAt: 0 }), 0)?.fraction).toBe(1)
  })

  it('adds the time since the last snapshot to the elapsed clock and flags a stall', () => {
    const snapshot = progress({ current: 10, elapsedMs: 2_000 })
    const view = deriveProgressView(record({ progress: snapshot, progressAt: 10_000 }), 10_000 + PROGRESS_STALL_MS)
    expect(view?.elapsedMs).toBe(2_000 + PROGRESS_STALL_MS)
    expect(view?.idleMs).toBe(PROGRESS_STALL_MS)
    expect(view?.stalled).toBe(true)
    expect(deriveProgressView(record({ progress: snapshot, progressAt: 10_000 }), 11_000)?.stalled).toBe(false)
  })

  it('returns null for records without normalized progress', () => {
    expect(deriveProgressView(record(), 0)).toBeNull()
  })
})

describe('nextProgressRate', () => {
  it('smooths the instantaneous rate between snapshots', () => {
    const first = progress({ unit: 'bytes', current: 0, elapsedMs: 0 })
    const second = progress({ unit: 'bytes', current: 1_000, elapsedMs: 1_000 })
    const third = progress({ unit: 'bytes', current: 3_000, elapsedMs: 2_000 })
    const rate = nextProgressRate(first, undefined, second)
    expect(rate).toBe(1_000)
    expect(nextProgressRate(second, rate, third)).toBeCloseTo(1_000 + 0.3 * (2_000 - 1_000))
  })

  it('drops the estimate when the unit or the step changes, and keeps it when the clock stalls', () => {
    const files = progress({ unit: 'files', current: 10, elapsedMs: 1_000 })
    const bytes = progress({ unit: 'bytes', current: 10, elapsedMs: 2_000 })
    expect(nextProgressRate(files, 5, bytes)).toBeUndefined()
    const stepOne = progress({ unit: 'fragments', current: 10, elapsedMs: 1_000, stepIndex: 1 })
    const stepTwo = progress({ unit: 'fragments', current: 0, elapsedMs: 2_000, stepIndex: 2 })
    expect(nextProgressRate(stepOne, 5, stepTwo)).toBeUndefined()
    expect(nextProgressRate(files, 5, progress({ unit: 'files', current: 10, elapsedMs: 1_000 }))).toBe(5)
  })
})

describe('selectActiveProgressRecord', () => {
  it('picks the most recent active stream that reports progress', () => {
    const older = record({ operationId: 'a', startedAt: 1, progress: progress() })
    const newer = record({ operationId: 'b', startedAt: 2, progress: progress() })
    const finished = record({ operationId: 'c', startedAt: 3, phase: 'succeeded', progress: progress() })
    const silent = record({ operationId: 'd', startedAt: 4 })
    expect(
      selectActiveProgressRecord(
        [older, newer, finished, silent],
        [older, newer, finished, silent],
        '/workspace/project'
      )?.operationId
    ).toBe('b')
    expect(selectActiveProgressRecord([finished, silent], [finished, silent], '/workspace/project')).toBeNull()
  })
})

describe('workspace progress and workflow labels', () => {
  it('selects current workspace progress while other repositories and global work remain active', () => {
    const a = record({ requestId: 'a', workspaceKey: '/repo/A', startedAt: 1, progress: progress() })
    const b = record({ requestId: 'b', workspaceKey: '/repo/B', startedAt: 2, progress: progress() })
    const global = record({ requestId: 'g', workspaceKey: null, startedAt: 3, progress: progress() })
    const records = [a, b, global]
    expect(selectActiveProgressRecord(records, records, '/repo/A')).toBe(a)
    expect(selectActiveProgressRecord(records, records, '/repo/B')).toBe(b)
    expect(selectActiveProgressRecord(records, records, null)).toBe(global)
    expect(selectActiveProgressRecord(records, [b, global], '/repo/A')).toBeNull()
    expect(selectActiveProgressRecord(records, records, '/repo/a')).toBeNull()
  })

  it('never labels background progress with another active command, even in the same workspace', () => {
    const child = record({ requestId: 'background', progress: progress() })
    const root: OperationRecord = {
      requestId: 'foreground',
      workspaceKey: child.workspaceKey,
      labelKey: 'sync',
      detail: { kind: 'text', text: '' },
      status: 'running',
      startedAt: 10
    }
    const active = [child, root]
    expect(selectActiveOperationRecord([root], active, child.workspaceKey, child.requestId)).toBeNull()
    expect(selectActiveOperationRecord([root], active, child.workspaceKey)).toBe(root)
    const matching = { ...root, requestId: child.requestId, labelKey: 'push', startedAt: 1 }
    expect(selectActiveOperationRecord([root, matching], active, child.workspaceKey, child.requestId)).toBe(matching)
    expect(selectActiveOperationRecord([root], active, '/other')).toBeNull()
  })
})

describe('formatElapsed', () => {
  it('formats minutes and hours', () => {
    expect(formatElapsed(0)).toBe('00:00')
    expect(formatElapsed(133_000)).toBe('02:13')
    expect(formatElapsed(3_723_000)).toBe('1:02:03')
  })
})

describe('mergeLoreOperationStream with normalized progress', () => {
  it('attaches the latest snapshot, its arrival time and a smoothed rate', () => {
    let records = mergeLoreOperationStream(
      [],
      {
        requestId: 'operation-7',
        workspaceKey: '/workspace/project',
        operationId: 'operation-7',
        operation: 'revision.commit',
        phase: 'streaming',
        event: {
          tagName: 'revisionCommitProgress',
          data: { unit: 'bytes', current: 0, total: 1_000, totalFinal: true, elapsedMs: 400 }
        },
        cancellable: false
      },
      10_000
    )
    records = mergeLoreOperationStream(
      records,
      {
        requestId: 'operation-7',
        workspaceKey: '/workspace/project',
        operationId: 'operation-7',
        operation: 'revision.commit',
        phase: 'streaming',
        event: {
          tagName: 'revisionCommitProgress',
          data: { unit: 'bytes', current: 500, total: 1_000, totalFinal: true, elapsedMs: 1_400 }
        },
        cancellable: false
      },
      11_000
    )
    expect(records[0]).toMatchObject({
      startedAt: 10_000,
      progressAt: 11_000,
      progressRate: 500,
      progress: { current: 500, total: 1_000 },
      eventCount: 2
    })
    // 终态事件不带快照，必须保留最后一次进度供操作中心回看。
    records = mergeLoreOperationStream(
      records,
      {
        requestId: 'operation-7',
        workspaceKey: '/workspace/project',
        operationId: 'operation-7',
        operation: 'revision.commit',
        phase: 'succeeded',
        durationMs: 1_500,
        cancellable: false
      },
      12_000
    )
    expect(records[0]).toMatchObject({ phase: 'succeeded', progressAt: 11_000, progress: { current: 500 } })
  })
})
