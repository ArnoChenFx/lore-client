import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'

import i18n from '../../i18n'
import type { AppUpdateState } from '../appUpdater'
import { UpdateDialog } from './UpdateDialog'

const markdownUpdateState: AppUpdateState = {
  phase: 'available',
  currentVersion: '0.2.1',
  availableVersion: '0.2.2',
  notes: [
    '## Changes',
    '',
    '- **Fix** the update manifest ([details](https://github.com/ArnoChenFx/lore-client))',
    '- Preserve `latest.json` signatures',
    '',
    '<script>window.releaseNotesExecuted = true</script>',
    '',
    '![tracking pixel](https://example.test/tracking.png)',
    '',
    '[unsafe link](javascript:window.releaseNotesExecuted=true)'
  ].join('\n'),
  downloadedBytes: 0,
  totalBytes: null,
  errorKind: null
}

describe('UpdateDialog Markdown release notes', () => {
  beforeEach(async () => {
    // 测试共享 i18n 单例；固定语言避免断言受其他测试执行顺序影响。
    await i18n.changeLanguage('en-US')
  })

  it('renders structured Markdown with secure external links', () => {
    const html = renderToStaticMarkup(
      <UpdateDialog state={markdownUpdateState} onInstall={() => undefined} onClose={() => undefined} />
    )

    expect(html).toContain('<h2>Changes</h2>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<strong>Fix</strong>')
    expect(html).toContain('<code>latest.json</code>')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('does not execute raw HTML or load remote Markdown images', () => {
    const html = renderToStaticMarkup(
      <UpdateDialog state={markdownUpdateState} onInstall={() => undefined} onClose={() => undefined} />
    )

    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('tracking.png')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('update-dialog__notes-image-alt')
    expect(html).toContain('tracking pixel')
  })

  it('allows retrying after an update download or installation failure', () => {
    const failedUpdateState: AppUpdateState = {
      ...markdownUpdateState,
      phase: 'error',
      errorKind: 'install'
    }
    const html = renderToStaticMarkup(
      <UpdateDialog state={failedUpdateState} onInstall={() => undefined} onClose={() => undefined} />
    )

    // 失败后必须保留同一更新上下文，并提供明确、可操作的重试入口。
    expect(html).toContain('Retry Download, Install, and Restart')
    expect(html).toMatch(/<button[^>]*class="is-primary"(?![^>]*disabled)[^>]*>/)
  })
})
