import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'

import i18n from '../../i18n'
import { createRevisionAvatarUrl, normalizeRevisionAuthorEmail } from '../../shared/ui'
import { SettingsDialog } from './SettingsDialog'

describe('commit author and email editors', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US')
  })

  it('splits an existing Git-style identity into accessible client settings inputs', () => {
    const html = renderToStaticMarkup(
      <SettingsDialog
        preference="system"
        language="en-US"
        defaultIdentity="YourName <yourname@example.com>"
        onPreferenceChange={() => undefined}
        onLanguageChange={() => undefined}
        onDefaultIdentityChange={() => undefined}
        onResetLayout={() => undefined}
        onClose={() => undefined}
      />
    )

    expect(html).toContain('aria-label="Default commit author"')
    expect(html).toContain('value="YourName"')
    expect(html).toContain('aria-label="Default commit email"')
    expect(html).toContain('value="yourname@example.com"')
    expect(html).toContain('revision-author-avatar--detail')
    expect(html).toContain('revision-author-avatar__fallback')
    expect(html).toContain('>Y</span>')
  })

  it('normalizes the settings email and creates the expected SHA-256 Gravatar URL', async () => {
    expect(normalizeRevisionAuthorEmail(' User@Example.COM ')).toBe('user@example.com')
    await expect(createRevisionAvatarUrl(' User@Example.COM ', 64)).resolves.toBe(
      'https://www.gravatar.com/avatar/b4c9a289323b21a01c3e940f150eb9b8c542587f1abfd8f0e1cc1ffc5e475514?s=64&d=404&r=g'
    )
  })
})
