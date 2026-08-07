export interface DiffsLocalizationLabels {
  unmodifiedLines: (count: number) => string
  moreUnchangedContext: string
  expandAll: string
  noNewlineAtEnd: string
  currentChangeMarker: string
  incomingChangeMarker: string
  acceptCurrentChange: string
  acceptIncomingChange: string
  acceptBothChanges: string
}

const UNMODIFIED_LINES_PATTERN = /^(\d+) unmodified lines?$/
const BUILT_IN_TEXT_SELECTORS = [
  '[data-unmodified-lines]',
  '[data-expand-all-button]',
  '[data-no-newline] > span',
  '[data-merge-conflict-action]'
].join(', ')

/**
 * 翻译 Diffs 直接写入 Shadow DOM 的固定英文文案。
 *
 * 数量从库生成的稳定英文格式中提取，再交给项目 i18n 处理复数；未知文本必须原样
 * 返回，避免第三方库升级后误改文件正文或新增控件。
 */
export function localizeDiffsBuiltInText(text: string, labels: DiffsLocalizationLabels): string {
  const unmodifiedLines = UNMODIFIED_LINES_PATTERN.exec(text)
  if (unmodifiedLines) return labels.unmodifiedLines(Number(unmodifiedLines[1]))
  if (text === 'More unchanged context may be available') return labels.moreUnchangedContext
  if (text === 'Expand all') return labels.expandAll
  if (text === 'No newline at end of file') return labels.noNewlineAtEnd
  if (text === 'Accept current change') return labels.acceptCurrentChange
  if (text === 'Accept incoming change') return labels.acceptIncomingChange
  if (text === 'Accept both') return labels.acceptBothChanges
  return text
}

/** 为 Diffs 样式表中硬编码的冲突侧伪元素生成当前语言覆盖。 */
export function createDiffsLocalizationCss(labels: DiffsLocalizationLabels): string {
  return `
[data-merge-conflict="marker-start"]::after {
  content: ${JSON.stringify(labels.currentChangeMarker)};
}
[data-merge-conflict="marker-end"]::after {
  content: ${JSON.stringify(labels.incomingChangeMarker)};
}
`
}

/**
 * 在 Diffs 官方 `onPostRender` 生命周期中更新 Shadow DOM 文本。
 *
 * 首次翻译时保留库生成的英文源文案，语言切换后即使节点没有被重新创建，也能从
 * 稳定源文案重新计算，而不会尝试解析上一次已经翻译过的字符串。
 */
export function localizeDiffsRenderedContent(container: HTMLElement, labels: DiffsLocalizationLabels): void {
  const root = container.shadowRoot ?? container
  root.querySelectorAll<HTMLElement>(BUILT_IN_TEXT_SELECTORS).forEach((element) => {
    const sourceText = element.dataset.loreDiffsSourceText ?? element.textContent?.trim()
    if (!sourceText) return
    const localizedText = localizeDiffsBuiltInText(sourceText, labels)
    if (localizedText === sourceText) return
    element.dataset.loreDiffsSourceText = sourceText
    element.textContent = localizedText
  })
}

/** 组合 Diffs 支持的 unsafeCSS 与 onPostRender 两个正式扩展点。 */
export function createDiffsLocalization(labels: DiffsLocalizationLabels) {
  return {
    unsafeCSS: createDiffsLocalizationCss(labels),
    onPostRender(container: HTMLElement, _instance: unknown, phase: 'mount' | 'update' | 'unmount') {
      if (phase !== 'unmount') localizeDiffsRenderedContent(container, labels)
    }
  }
}
