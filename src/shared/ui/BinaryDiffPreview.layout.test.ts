import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/** 读取指定选择器的声明块，让回归测试直接约束浏览器实际消费的布局规则。 */
function readRule(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rule = css.match(new RegExp(`(?:^|\\n)\\s*${escapedSelector}\\s*\\{([^}]*)\\}`))?.[1]

  if (!rule) {
    throw new Error(`Missing CSS rule for ${selector}`)
  }

  return rule
}

describe('binary diff preview layout', () => {
  it('shares comparison height while keeping the model information row visible', () => {
    const css = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8')
    const comparison = readRule(css, '.binary-diff-preview.has-comparison')
    const comparisonCard = readRule(css, '.binary-diff-preview.has-comparison > .binary-diff-preview__card')
    const modelViewer = readRule(css, '.binary-diff-preview__model-viewer')
    const comparisonModelViewer = readRule(
      css,
      '.binary-diff-preview.has-comparison .binary-diff-preview__model-viewer'
    )
    const comparisonModelHost = readRule(css, '.binary-diff-preview.has-comparison .binary-diff-preview__model-host')
    const comparisonModelCanvas = readRule(
      css,
      '.binary-diff-preview.has-comparison .binary-diff-preview__model-host > canvas'
    )

    // 两个版本由同一个剩余空间网格等分，不能再以固定像素下限挤占下方工作区。
    expect(comparison).toMatch(/grid-auto-rows:\s*minmax\(0,\s*1fr\)/)
    expect(comparison).toMatch(/overflow:\s*hidden/)
    expect(comparisonCard).toMatch(/min-height:\s*0/)

    // 信息栏保留自然高度；模型查看器与绝对定位宿主只使用它上方的弹性空间。
    expect(modelViewer).toMatch(/grid-template-rows:\s*minmax\(0,\s*1fr\)\s+auto/)
    expect(comparisonModelViewer).toMatch(/min-height:\s*0/)
    expect(comparisonModelHost).toMatch(/min-height:\s*0/)
    expect(comparisonModelCanvas).toMatch(/min-height:\s*0/)
  })

  it('uses compact minimum heights for cards and canvas previews', () => {
    const css = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8')

    // 卡片下限只负责保证紧凑可用性；模型与纹理画布保留略高的操作空间。
    expect(readRule(css, '.binary-diff-preview')).toMatch(/grid-auto-rows:\s*minmax\(220px,\s*1fr\)/)
    expect(readRule(css, '.binary-diff-preview__card')).toMatch(/min-height:\s*220px/)
    expect(readRule(css, '.binary-diff-preview__model-viewer')).toMatch(/min-height:\s*280px/)
    expect(readRule(css, '.binary-diff-preview__model-host')).toMatch(/min-height:\s*240px/)
    expect(readRule(css, '.binary-diff-preview__model-host > canvas')).toMatch(/min-height:\s*240px/)
    expect(readRule(css, '.binary-diff-preview__texture-viewer')).toMatch(/min-height:\s*280px/)
    expect(readRule(css, '.binary-diff-preview__texture-host')).toMatch(/min-height:\s*240px/)
    expect(readRule(css, '.binary-diff-preview__texture-host > canvas')).toMatch(/min-height:\s*240px/)
  })

  it('places asset metadata before an optional thumbnail without clipping either section', () => {
    const css = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8')
    const assetLayout = readRule(css, '.binary-diff-preview__asset-layout')
    const assetLayoutWithThumbnail = readRule(css, '.binary-diff-preview__asset-layout.has-thumbnail')
    const assetMetadata = readRule(css, '.binary-diff-preview__asset-layout > .binary-diff-preview__structured-viewer')
    const assetThumbnail = readRule(css, '.binary-diff-preview__asset-thumbnail')

    // 无缩略图时只有自然高度元数据轨道；有缩略图时，图片位于其下方并由同一容器滚动。
    expect(assetLayout).toMatch(/grid-template-rows:\s*max-content/)
    expect(assetLayout).toMatch(/overflow:\s*auto/)
    expect(assetLayoutWithThumbnail).toMatch(/grid-template-rows:\s*max-content\s+minmax\(160px,\s*1fr\)/)
    expect(assetMetadata).toMatch(/grid-auto-rows:\s*max-content/)
    expect(assetMetadata).toMatch(/overflow:\s*visible/)
    expect(assetThumbnail).toMatch(/border-top:\s*1px\s+solid\s+var\(--line\)/)
  })

  it('keeps structured asset metadata in compact inline pairs', () => {
    const css = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8')
    const metadataItem = readRule(css, '.binary-diff-preview__metadata-grid > div')
    const metadataLabel = readRule(css, '.binary-diff-preview__metadata-grid dt')
    const metadataValue = readRule(css, '.binary-diff-preview__metadata-grid dd')

    // 键和值共享同一行，右对齐的值不会再为每个属性额外占用一行高度。
    expect(metadataItem).toMatch(/display:\s*grid/)
    expect(metadataItem).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/)
    expect(metadataItem).toMatch(/padding:\s*4px\s+8px/)
    expect(metadataLabel).toMatch(/text-overflow:\s*ellipsis/)
    expect(metadataLabel).toMatch(/white-space:\s*nowrap/)
    expect(metadataValue).toMatch(/margin:\s*0/)
    expect(metadataValue).toMatch(/text-align:\s*right/)
  })
})
