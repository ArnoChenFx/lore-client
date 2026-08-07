import { describe, expect, it } from 'vitest'

import { createDiffsLocalizationCss, type DiffsLocalizationLabels, localizeDiffsBuiltInText } from './diffsLocalization'

const labels: DiffsLocalizationLabels = {
  unmodifiedLines: (count) => `${count} 行未修改`,
  moreUnchangedContext: '可能还有更多未修改上下文',
  expandAll: '展开全部',
  noNewlineAtEnd: '文件末尾没有换行符',
  currentChangeMarker: '（当前更改）',
  incomingChangeMarker: '（传入更改）',
  acceptCurrentChange: '接受当前更改',
  acceptIncomingChange: '接受传入更改',
  acceptBothChanges: '接受两者'
}

describe('Diffs built-in localization', () => {
  it('translates rendered separator and action text while preserving counts', () => {
    expect(localizeDiffsBuiltInText('1 unmodified line', labels)).toBe('1 行未修改')
    expect(localizeDiffsBuiltInText('6 unmodified lines', labels)).toBe('6 行未修改')
    expect(localizeDiffsBuiltInText('More unchanged context may be available', labels)).toBe('可能还有更多未修改上下文')
    expect(localizeDiffsBuiltInText('Expand all', labels)).toBe('展开全部')
    expect(localizeDiffsBuiltInText('No newline at end of file', labels)).toBe('文件末尾没有换行符')
    expect(localizeDiffsBuiltInText('Accept current change', labels)).toBe('接受当前更改')
    expect(localizeDiffsBuiltInText('ordinary source text', labels)).toBe('ordinary source text')
  })

  it('overrides the hard-coded conflict marker pseudo-element labels', () => {
    const css = createDiffsLocalizationCss(labels)

    expect(css).toContain('[data-merge-conflict="marker-start"]::after')
    expect(css).toContain('content: "（当前更改）"')
    expect(css).toContain('[data-merge-conflict="marker-end"]::after')
    expect(css).toContain('content: "（传入更改）"')
  })
})
