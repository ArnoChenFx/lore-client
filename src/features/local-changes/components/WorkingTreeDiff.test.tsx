import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'

import i18n from '../../../i18n'
import { updateClientPreferences } from '../../../services/preferences'
import { createBinaryDiffPreviewView } from '../../../shared/ui'
import type {
  BinaryDiffPreview as BinaryDiffPreviewData,
  ChangeFile,
  WorkingTreeDiff as WorkingTreeDiffData
} from '../../../types'
import { WorkingTreeDiff as WorkingTreeDiffView } from './WorkingTreeDiff'

/** 测试夹具保持稳定 IPC DTO 形状，进入组件前走与数据容器相同的视图转换。 */
function WorkingTreeDiff({
  binaryPreview,
  ...props
}: Omit<ComponentProps<typeof WorkingTreeDiffView>, 'binaryPreview'> & {
  binaryPreview: BinaryDiffPreviewData | null
}) {
  return (
    <WorkingTreeDiffView {...props} binaryPreview={binaryPreview ? createBinaryDiffPreviewView(binaryPreview) : null} />
  )
}

const csvFile: ChangeFile = {
  id: 'data/market.csv',
  path: 'data',
  name: 'market.csv',
  status: 'added',
  staged: false,
  binary: false,
  contentClassification: { kind: 'text', source: 'utf8' },
  additions: 0,
  deletions: 0
}

describe('working-tree binary Diff visibility', () => {
  beforeEach(async () => {
    // 固定语言后直接断言可访问文案，避免测试受共享 i18n 单例影响。
    await i18n.changeLanguage('zh-CN')
    // 偏好服务是进程级单例，每个用例都恢复产品默认显示状态，避免相互污染。
    updateClientPreferences({ binaryDiffVisible: true })
  })

  it('renders CSV as a text diff when binary Diff is disabled', () => {
    updateClientPreferences({ binaryDiffVisible: false })
    const diff: WorkingTreeDiffData = {
      path: 'data/market.csv',
      action: 'modify',
      patch: '--- a/data/market.csv\n+++ b/data/market.csv\n@@ -1 +1 @@\n-symbol,price\n-BTC,100\n+BTC,101',
      contentClassification: { kind: 'text', source: 'loreDiff' }
    }

    const html = renderToStaticMarkup(
      <WorkingTreeDiff
        file={csvFile}
        selectionLabel={null}
        selectedCount={1}
        diff={diff}
        loading={false}
        error={null}
        binaryPreview={{
          before: {
            path: 'data/market.csv',
            kind: 'csv',
            mimeType: 'text/csv',
            data: new Uint8Array(),
            size: 4 * 1024,
            contentState: 'metadataOnly'
          },
          after: {
            path: 'data/market.csv',
            kind: 'csv',
            mimeType: 'text/csv',
            data: new Uint8Array(),
            size: 8 * 1024,
            contentState: 'metadataOnly'
          }
        }}
        binaryPreviewLoading={false}
        binaryPreviewError={null}
      />
    )

    // Diffs 库渲染为 Shadow DOM 自定义元素，SSR 阶段只有容器外壳；正文由客户端挂载。
    expect(html).toContain('working-diff__viewport')
    expect(html).toContain('diffs-container')
    expect(html).not.toContain('二进制 Diff 已隐藏')
    expect(html).not.toContain('binary-diff-preview__csv')
  })

  it('renders CSV as a table preview when binary Diff is enabled', () => {
    const html = renderToStaticMarkup(
      <WorkingTreeDiff
        file={csvFile}
        selectionLabel={null}
        selectedCount={1}
        diff={null}
        loading={false}
        error={null}
        binaryPreview={{
          after: {
            path: 'data/market.csv',
            kind: 'csv',
            mimeType: 'text/csv',
            data: new TextEncoder().encode('symbol,price\nBTC,101'),
            size: 20,
            contentState: 'available'
          }
        }}
        binaryPreviewLoading={false}
        binaryPreviewError={null}
      />
    )

    expect(html).toContain('binary-diff-preview__csv')
    expect(html).not.toContain('diffs-container')
  })

  it('keeps the Diff body empty while loading', () => {
    const html = renderToStaticMarkup(
      <WorkingTreeDiff
        file={csvFile}
        selectionLabel={null}
        selectedCount={1}
        diff={null}
        loading
        error={null}
        binaryPreview={null}
        binaryPreviewLoading={false}
        binaryPreviewError={null}
      />
    )

    expect(html).toContain('working-diff__header')
    expect(html).not.toContain('working-diff__empty')
    expect(html).not.toContain('正在读取 Lore Diff')
    expect(html).not.toContain('is-spinning')
  })
})
