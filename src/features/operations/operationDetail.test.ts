import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import i18n from '../../i18n'
import zhCN from '../../i18n/locales/zh-CN'
import { operationMessage, operationText, resolveOperationDetail } from './operationDetail'

describe('operation record details', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN')
  })

  afterEach(async () => {
    // Bun 默认让测试文件共享 i18n 单例；统一恢复英文，避免污染其他英文测试。
    await i18n.changeLanguage('en-US')
  })

  it('keeps plain text details unchanged across language changes', async () => {
    const detail = operationText('E:\\repo')
    expect(resolveOperationDetail(detail)).toBe('E:\\repo')
    await i18n.changeLanguage('en-US')
    expect(resolveOperationDetail(detail)).toBe('E:\\repo')
  })

  it('retranslates semantic detail keys after the language changes', async () => {
    const detail = operationMessage('status.repositoriesLoaded', { count: 3 })
    expect(resolveOperationDetail(detail)).toBe(zhCN.status.repositoriesLoaded.replace('{{count}}', '3'))
    await i18n.changeLanguage('en-US')
    expect(resolveOperationDetail(detail)).toBe('Loaded 3 repositories')
  })
})
