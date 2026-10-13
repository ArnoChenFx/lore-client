import { afterEach, describe, expect, it } from 'vitest'

import i18n from '../../i18n'
import { resolveLoreEventLabel } from './operationStreamLabels'

/** Rust 端归一化进度快照使用的事件名，及其在两种语言下应显示的阶段名。 */
const PROGRESS_EVENT_LABELS = [
  ['fileStageProgress', '暂存进度', 'Stage Progress'],
  ['revisionCommitProgress', '提交进度', 'Commit Progress'],
  ['revisionSyncProgress', '同步进度', 'Sync Progress'],
  ['branchPushFragmentProgress', '推送进度', 'Push Progress'],
  ['repositoryCloneProgress', '克隆进度', 'Clone Progress']
] as const

describe('Lore progress event labels', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en-US')
  })

  it('translates every normalized progress event instead of falling back to the protocol name', async () => {
    for (const [tagName, zh, en] of PROGRESS_EVENT_LABELS) {
      await i18n.changeLanguage('zh-CN')
      expect(resolveLoreEventLabel(tagName)).toBe(zh)
      await i18n.changeLanguage('en-US')
      expect(resolveLoreEventLabel(tagName)).toBe(en)
    }
  })

  it('still humanizes events that have no label', () => {
    expect(resolveLoreEventLabel('someFutureEvent')).toBe('Some Future Event')
    expect(resolveLoreEventLabel(undefined)).toBe('—')
  })
})
