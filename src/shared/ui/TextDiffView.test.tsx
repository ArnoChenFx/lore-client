import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '../../i18n'
import { normalizePatchPath, TextDiffView } from './TextDiffView'

const samplePatch = '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-old line\n+new line\n context\n'

describe('TextDiffView', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN')
  })

  it('renders nothing for an empty or unparseable patch', () => {
    expect(renderToStaticMarkup(<TextDiffView patch="" filePath="a.txt" themeType="dark" />)).toBe('')
    expect(renderToStaticMarkup(<TextDiffView patch="not a patch" filePath="a.txt" themeType="dark" />)).toBe('')
  })

  it('renders the diff shell for a parseable patch', () => {
    const html = renderToStaticMarkup(<TextDiffView patch={samplePatch} filePath="a.txt" themeType="dark" />)
    expect(html).toContain('text-diff-view')
  })

  it('normalizes parser paths to real repository paths', () => {
    // Diffs 库从 `--- a/`、`+++ b/` 头部保留的路径前缀。
    expect(normalizePatchPath('a/Content/World.txt')).toBe('Content/World.txt')
    expect(normalizePatchPath('b/Content/World.txt')).toBe('Content/World.txt')
    expect(normalizePatchPath('Content/World.txt')).toBe('Content/World.txt')
    // 真实目录就叫 b 时，只剥解析器附加的第一个前缀段。
    expect(normalizePatchPath('b/b/World.txt')).toBe('b/World.txt')
    expect(normalizePatchPath('a/b\\World.txt')).toBe('b/World.txt')
    // Lore 统一 Diff 标签的 `@<revision>` 后缀不是路径的一部分，必须剥掉。
    expect(normalizePatchPath('src/scd.txt@120001')).toBe('src/scd.txt')
    expect(normalizePatchPath('b/src/scd.txt@120002')).toBe('src/scd.txt')
    expect(normalizePatchPath('src/scd.txt@12')).toBe('src/scd.txt')
    // 非末尾数字的 @ 与末尾非数字后缀保持原样。
    expect(normalizePatchPath('report@2024.txt')).toBe('report@2024.txt')
    expect(normalizePatchPath('dir@2/file.txt')).toBe('dir@2/file.txt')
  })

  it('accepts split layout and full-file expansion without changing the shell', () => {
    const loader = vi.fn()
    const html = renderToStaticMarkup(
      <TextDiffView
        patch={samplePatch}
        filePath="a.txt"
        themeType="dark"
        diffStyle="split"
        expandFullFile
        loadDiffFiles={loader}
      />
    )
    expect(html).toContain('text-diff-view')
    // SSR 不会触发挂载期加载；真实模式下由 Diffs 库在客户端调用加载器。
    expect(loader).not.toHaveBeenCalled()
  })
})
