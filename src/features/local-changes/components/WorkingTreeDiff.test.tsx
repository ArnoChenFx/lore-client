import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'

import i18n from '../../../i18n'
import { updateClientPreferences } from '../../../services/preferences'
import type { ChangeFile } from '../../../types'
import { WorkingTreeDiff } from './WorkingTreeDiff'

const csvFile: ChangeFile = {
  id: 'data/market.csv',
  path: 'data',
  name: 'market.csv',
  status: 'added',
  staged: false,
  binary: false,
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

  it('does not render the CSV visualization when binary Diff is disabled', () => {
    updateClientPreferences({ binaryDiffVisible: false })

    const html = renderToStaticMarkup(
      <WorkingTreeDiff
        file={csvFile}
        selectionLabel={null}
        selectedCount={1}
        diff={null}
        loading={false}
        error={null}
        binaryPreview={null}
        binaryPreviewLoading={false}
        binaryPreviewError={null}
      />
    )

    expect(html).toContain('二进制 Diff 已隐藏')
    expect(html).toContain('可在 Diff 选项中重新启用二进制 Diff。')
    expect(html).not.toContain('binary-diff-preview')
  })
})
