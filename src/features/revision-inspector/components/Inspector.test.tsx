import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { InspectorTabs } from './Inspector'

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
