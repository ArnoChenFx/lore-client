import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'

import i18n from '../../i18n'
import { AboutDialog } from './AboutDialog'
import { ProjectReleasesLink, ProjectRepositoryLink } from './ProjectRepositoryLink'
import { UpdateDialog } from './UpdateDialog'

describe('ProjectRepositoryLink', () => {
  beforeEach(async () => {
    // 测试共享 i18n 单例；固定为英文，避免断言依赖其他测试文件的执行顺序。
    await i18n.changeLanguage('en-US')
  })

  it('renders the public repository as a secure external link', () => {
    const html = renderToStaticMarkup(<ProjectRepositoryLink />)

    expect(html).toContain('href="https://github.com/ArnoChenFx/lore-client"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('aria-label="Open the Lore Client project repository on GitHub"')
    expect(html).toContain('class="project-repository-link__mark"')
    expect(html).toContain('ArnoChenFx/lore-client')
  })

  it('renders releases as an accessible icon-only GitHub link', () => {
    const html = renderToStaticMarkup(<ProjectReleasesLink />)

    expect(html).toContain('href="https://github.com/ArnoChenFx/lore-client/releases"')
    expect(html).toContain('aria-label="Open the Lore Client releases on GitHub"')
    expect(html).toContain('project-repository-link--icon-only')
    expect(html).toContain('project-repository-link__mark')
    expect(html).not.toContain('<span>ArnoChenFx/lore-client</span>')
  })

  it('keeps the repository entry in About and places releases after the available version', () => {
    const aboutHtml = renderToStaticMarkup(<AboutDialog runtimeInfo={null} onClose={() => undefined} />)
    const updateHtml = renderToStaticMarkup(
      <UpdateDialog
        state={{
          phase: 'available',
          currentVersion: '0.2.1',
          availableVersion: '0.2.2',
          notes: 'Release notes',
          downloadedBytes: 0,
          totalBytes: null,
          errorKind: null
        }}
        onInstall={() => undefined}
        onClose={() => undefined}
      />
    )

    expect(aboutHtml).toContain('about-content__repository-link')
    expect(updateHtml).toContain('update-dialog__releases-link')
    expect(updateHtml).toContain('update-dialog__version--available')
    expect(updateHtml).toContain('href="https://github.com/ArnoChenFx/lore-client/releases"')
    expect(aboutHtml.match(/<a class="project-repository-link/g)).toHaveLength(1)
    expect(updateHtml.match(/<a class="project-repository-link/g)).toHaveLength(1)

    const availableVersionStart = updateHtml.indexOf('<div class="update-dialog__version--available">')
    const availableVersionEnd = updateHtml.indexOf('</div>', availableVersionStart)
    const availableVersionHtml = updateHtml.slice(availableVersionStart, availableVersionEnd)
    expect(availableVersionHtml.indexOf('<dd>0.2.2</dd>')).toBeLessThan(
      availableVersionHtml.indexOf('update-dialog__releases-link')
    )
  })
})
