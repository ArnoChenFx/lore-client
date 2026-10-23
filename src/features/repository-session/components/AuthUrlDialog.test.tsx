import { beforeEach, describe, expect, it } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import i18n from '../../../i18n'
import { AuthUrlDialog } from './AuthUrlDialog'

describe('AuthUrlDialog', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US')
  })

  it('shows the confirmation code and the sign-in page it belongs to', () => {
    const html = renderToStaticMarkup(
      <AuthUrlDialog
        prompt={{
          operationId: 'lore-operation-1',
          operation: 'auth.login-interactive',
          url: 'https://auth.example/device',
          userCode: 'WDJB-8KQT'
        }}
        onDismiss={() => undefined}
      />
    )

    expect(html).toContain('Sign-in confirmation code')
    expect(html).toContain('WDJB-8KQT')
    expect(html).toContain('Copy code')
    expect(html).toContain('https://auth.example/device')
    expect(html).toContain('aria-modal="true"')
  })

  it('omits the code row when the login session has no user code', () => {
    const html = renderToStaticMarkup(
      <AuthUrlDialog
        prompt={{
          operationId: 'lore-operation-2',
          operation: 'auth.login-interactive',
          url: 'https://auth.example/login',
          userCode: ''
        }}
        onDismiss={() => undefined}
      />
    )

    expect(html).not.toContain('Copy code')
    expect(html).toContain('https://auth.example/login')
  })
})
