import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import i18n from '../../../i18n'
import { humanizeLoreIdentifier, resolveLoreEventLabel, resolveLoreOperationLabel } from '../operationStreamLabels'
import { OperationCenter } from './OperationCenter'

describe('operation center stream localization', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN')
  })

  afterEach(async () => {
    // 测试共享同一个 i18n 单例，结束后恢复英文，避免污染其他测试文件。
    await i18n.changeLanguage('en-US')
  })

  it('localizes Lore operation and event identifiers instead of exposing protocol names', () => {
    const html = renderToStaticMarkup(
      <OperationCenter
        operations={[]}
        streams={[
          {
            operationId: 'operation-1',
            operation: 'revision_tree.list_children',
            phase: 'succeeded',
            startedAt: Date.now(),
            durationMs: 10,
            eventCount: 11,
            lastEventTag: 'end',
            bytes: 3_276,
            cancellable: false
          }
        ]}
        onClear={() => undefined}
        onClose={() => undefined}
      />
    )

    expect(html).toContain('列出子修订')
    expect(html).toContain('结束')
    expect(html).not.toContain('revision_tree.list_children')
    expect(html).not.toMatch(/· end(?:<|$)/)
    expect(html).not.toContain('实时 Lore 事件流')
    expect(html).not.toContain('固定 Lore 没有通用长操作取消接口')
  })

  it('retranslates stream labels when the application language changes', async () => {
    expect(resolveLoreOperationLabel('revision_tree.list_children')).toBe('列出子修订')
    expect(resolveLoreEventLabel('end')).toBe('结束')

    await i18n.changeLanguage('en-US')

    expect(resolveLoreOperationLabel('revision_tree.list_children')).toBe('List Child Revisions')
    expect(resolveLoreEventLabel('end')).toBe('Finished')
  })

  it('keeps unknown future identifiers readable without inventing a translation', () => {
    expect(humanizeLoreIdentifier('custom.future_operation')).toBe('Custom Future Operation')
    expect(resolveLoreEventLabel('futureEventStage')).toBe('Future Event Stage')
  })
})
