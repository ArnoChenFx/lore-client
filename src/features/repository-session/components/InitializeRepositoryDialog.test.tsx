import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'

import i18n from '../../../i18n'
import { InitializeRepositoryDialog } from './InitializeRepositoryDialog'

describe('InitializeRepositoryDialog', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN')
  })

  it('prefills the repository identity and renders Shared Store controls', () => {
    const html = renderToStaticMarkup(
      <InitializeRepositoryDialog
        directoryPath="E:\\Worlds\\NewProject"
        defaultIdentity="ArnoChen <arnochen101@gmail.com>"
        sharedStoreInfo={{ useAutomatically: true, stores: [], totalSizeBytes: 0, exactSavingsAvailable: false }}
        busy={false}
        error={null}
        onConfirm={() => undefined}
        onClose={() => undefined}
      />
    )

    expect(html).toContain('使用共享内容存储')
    expect(html).toContain('共享内容存储路径（可选）')
    expect(html).toContain('本次初始化将使用共享内容存储。')
    expect(html).toContain('value="ArnoChen"')
    expect(html).toContain('value="arnochen101@gmail.com"')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('disabled=""')
  })
})
