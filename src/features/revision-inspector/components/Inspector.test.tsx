import { describe, expect, it } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import i18n from '../../../i18n'
import { parseRepository } from '../../../services/lore/repositories'
import { parseRevisions } from '../../../services/lore/revisions'
import { InspectorTabs, OverviewTab } from './Inspector'

describe('Revision Inspector history localization', () => {
  it('renders already-loaded revision facts after changing language without a history reload', async () => {
    await i18n.changeLanguage('en-US')
    const repository = parseRepository('/repository', [])
    const revision = parseRevisions(
      [{ tagName: 'revisionHistoryEntry', data: { revision: 'abcdef1234567890', revisionNumber: 12 } }],
      repository
    )[0]!
    const render = () =>
      renderToStaticMarkup(<OverviewTab revision={revision} demoMode={false} onOpenOperations={() => undefined} />)

    try {
      const english = render()
      expect(english).toContain('Unknown author')
      expect(english).toContain('Unknown time')

      await i18n.changeLanguage('zh-CN')
      const chinese = render()
      expect(chinese).toContain('未知作者')
      expect(chinese).toContain('时间未知')
      expect(chinese).toContain(i18n.t('status.revisionLabel', { number: 12, id: 'abcdef12' }))
      expect(chinese).not.toContain('Unknown author')
    } finally {
      await i18n.changeLanguage('en-US')
    }
  })
})

describe('Revision Inspector change counts', () => {
  it('does not render an unknown lightweight change count as zero', () => {
    const html = renderToStaticMarkup(
      <InspectorTabs
        activeTab="overview"
        filesChanged={undefined}
        diffVisible
        onTabChange={() => undefined}
        onToggleDiff={() => undefined}
      />
    )

    // 文案取决于当前测试进程的全局语言；这里只验证未知数量不会被伪装为真实的零。
    expect(html).not.toContain('<small>0</small>')
  })

  it('renders the exact lightweight change count after loading', () => {
    const zeroHtml = renderToStaticMarkup(
      <InspectorTabs
        activeTab="overview"
        filesChanged={0}
        diffVisible
        onTabChange={() => undefined}
        onToggleDiff={() => undefined}
      />
    )
    const nonZeroHtml = renderToStaticMarkup(
      <InspectorTabs
        activeTab="overview"
        filesChanged={3}
        diffVisible
        onTabChange={() => undefined}
        onToggleDiff={() => undefined}
      />
    )

    expect(zeroHtml).toContain('<small>0</small>')
    expect(nonZeroHtml).toContain('<small>3</small>')
  })
})
