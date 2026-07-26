import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'

import i18n from '../../i18n'
import type { Branch } from '../../types'
import { ArchivedBranchMenuItems } from './VersionContextMenu'

const archivedBranch: Branch = {
  id: 'local:archived',
  name: 'feature/archived',
  latest: 'abcdef1234567890',
  archived: true
}

describe('archived branch menu', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US')
  })

  it('offers only locate, tag, and copy actions while explicitly disabling restore', () => {
    const html = renderToStaticMarkup(
      <ArchivedBranchMenuItems
        branch={archivedBranch}
        busy={false}
        closeThen={(action) => action()}
        copyText={async () => undefined}
        onOpenBranchRevision={() => undefined}
        onCreateTag={() => undefined}
      />
    )

    expect(html).toContain('Locate the archived branch revision')
    expect(html).toContain('Create tag on revision')
    expect(html).toContain('Copy branch name')
    expect(html).toContain('Copy latest revision ID')
    expect(html).not.toContain('Switch to this branch')
    expect(html).not.toContain('Archive Branch…')
  })
})
