import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import i18n from '../../../i18n'
import type { LoreOperationStreamRecord, OperationProgress } from '../../../types'
import { PROGRESS_STALL_MS } from '../operationProgress'
import { OperationProgressStatus } from './OperationProgressStatus'

function render(operation: string, tagName: string, progress: OperationProgress, now = 0, progressAt = 0): string {
  const record: LoreOperationStreamRecord = {
    operationId: 'operation-1',
    operation,
    phase: 'streaming',
    startedAt: 0,
    eventCount: 1,
    lastEventTag: tagName,
    progress,
    progressAt,
    cancellable: false
  }
  return renderToStaticMarkup(<OperationProgressStatus record={record} label={null} now={now} />)
}

describe('status bar operation progress', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN')
  })

  afterEach(async () => {
    await i18n.changeLanguage('en-US')
  })

  it('shows staging as an indeterminate bar with a running count and no percentage', () => {
    const html = render('file.stage', 'fileStageProgress', {
      unit: 'files',
      current: 1_203,
      totalFinal: false,
      elapsedMs: 4_000
    })
    expect(html).toContain('role="progressbar"')
    expect(html).not.toContain('aria-valuenow')
    expect(html).toContain('is-indeterminate')
    expect(html).toContain('已暂存 1,203 个文件')
    expect(html).toContain('00:04')
    expect(html).not.toContain('%')
  })

  it('words a count-only snapshot by its event name, not by the operation that happens to run it', () => {
    const counted: OperationProgress = { unit: 'files', current: 7, totalFinal: false, elapsedMs: 1_000 }
    expect(render('revision.commit', 'fileStageProgress', counted)).toContain('已暂存 7 个文件')
    // 其他事件的“只有计数”快照不能被说成已暂存。
    const preparing = render('file.stage', 'revisionCommitProgress', counted)
    expect(preparing).toContain('正在准备…')
    expect(preparing).not.toContain('已暂存')
  })

  it('shows a determinate bar with an exposed value once the total is final', () => {
    const html = render('revision.commit', 'revisionCommitProgress', {
      unit: 'bytes',
      current: 84_885_372,
      total: 169_770_744,
      totalFinal: true,
      files: 18_462,
      filesTotal: 100_003,
      elapsedMs: 662
    })
    expect(html).toContain('aria-valuenow="50"')
    expect(html).toContain('width:50%')
    expect(html).not.toContain('is-indeterminate')
    expect(html).toContain('50%')
    expect(html).toContain('18,462 / 100,003 个文件')
  })

  it('keeps the push preparation phase indeterminate and numbers the revisions', () => {
    const html = render('branch.push', 'branchPushFragmentProgress', {
      unit: 'fragments',
      current: 0,
      totalFinal: false,
      stepIndex: 1,
      stepCount: 3,
      elapsedMs: 9_000
    })
    expect(html).toContain('is-indeterminate')
    expect(html).toContain('版本 1/3')
    expect(html).toContain('正在准备…')
  })

  it('reports fragment progress with uploaded bytes but never a byte percentage', () => {
    const html = render('branch.push', 'branchPushFragmentProgress', {
      unit: 'fragments',
      current: 250,
      total: 1_000,
      totalFinal: true,
      bytes: 10_485_760,
      stepIndex: 2,
      stepCount: 2,
      elapsedMs: 30_000
    })
    expect(html).toContain('aria-valuenow="25"')
    expect(html).toContain('250 / 1,000 个片段')
    expect(html).toContain('已上传 10.0 MB')
  })

  it('warns when no new snapshot arrives for a long time', () => {
    const html = render(
      'branch.push',
      'branchPushFragmentProgress',
      { unit: 'fragments', current: 250, total: 1_000, totalFinal: true, elapsedMs: 30_000 },
      PROGRESS_STALL_MS + 5_000,
      5_000
    )
    expect(html).toContain('is-stalled')
    expect(html).toContain('已 15 秒无进展')
    // 总耗时仍然显示（快照里的 30 秒加上到达后的 15 秒），停滞秒数只统计距上一个快照的间隔。
    expect(html).toContain('00:45')
  })

  it('retranslates when the application language changes', async () => {
    await i18n.changeLanguage('en-US')
    const html = render('file.stage', 'fileStageProgress', {
      unit: 'files',
      current: 1_203,
      totalFinal: false,
      elapsedMs: 4_000
    })
    expect(html).toContain('1,203 files staged')
  })
})
