import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'

import i18n from '../../../i18n'
import { RemoteAuthenticationDialog } from './RemoteAuthenticationDialog'

describe('RemoteAuthenticationDialog', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US')
  })

  it('offers explicit reauthentication and offline choices with affected repositories', () => {
    const html = renderToStaticMarkup(
      <RemoteAuthenticationDialog
        target={{ serverUrl: 'lore://server:41337', repositoryNames: ['project-a', 'project-b'] }}
        busy={false}
        error={null}
        onAuthenticate={() => undefined}
        onContinueOffline={() => undefined}
      />
    )

    expect(html).toContain('Remote authentication expired')
    expect(html).toContain('lore://server:41337')
    expect(html).toContain('project-a, project-b')
    expect(html).toContain('Skip and continue offline')
    expect(html).toContain('Reauthenticate')
    expect(html).toContain('aria-modal="true"')
  })

  it('keeps both choices disabled while authentication is running', () => {
    const html = renderToStaticMarkup(
      <RemoteAuthenticationDialog
        target={{ serverUrl: 'lore://server:41337', repositoryNames: [] }}
        busy
        error="authentication_verification_failed"
        onAuthenticate={() => undefined}
        onContinueOffline={() => undefined}
      />
    )

    expect(html.match(/disabled=""/g)).toHaveLength(2)
    expect(html).toContain('Authenticating…')
    expect(html).toContain('repository connection could not be verified')
  })
})
