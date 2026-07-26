import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'

import i18n from '../../../i18n'
import type { Branch, ChangeFile } from '../../../types'
import { LocalChanges } from './LocalChanges'

const files: ChangeFile[] = [
  {
    id: 'Content/Textures/Sky.png',
    path: 'Content/Textures',
    name: 'Sky.png',
    status: 'modified',
    staged: false,
    additions: 0,
    deletions: 0,
    binary: true
  }
]

const branches: Branch[] = [
  {
    id: 'local:main',
    name: 'main',
    latest: 'target-revision',
    current: true
  },
  {
    id: 'local:feature',
    name: 'feature',
    latest: 'incoming-revision'
  }
]

describe('local changes tree toolbar', () => {
  beforeEach(async () => {
    // Bun 默认会让测试文件共享 i18n 单例；统一使用英文避免跨文件语言状态污染。
    await i18n.changeLanguage('en-US')
  })

  it('shows file-level conflict actions and disables the ordinary commit flow during a conflict session', () => {
    const noop = () => undefined
    const conflictFiles: ChangeFile[] = [
      {
        ...files[0],
        id: 'Content/Conflict.txt',
        path: 'Content',
        name: 'Conflict.txt',
        binary: false,
        staged: true,
        conflict: true,
        conflictUnresolved: true
      }
    ]
    const html = renderToStaticMarkup(
      <LocalChanges
        repositoryPath="E:/Repositories/demo"
        branches={branches}
        currentBranch="main"
        files={conflictFiles}
        conflictSession={{
          kind: 'merge',
          currentRevision: 'current-revision',
          stagedRevision: 'staged-revision',
          incomingRevision: 'incoming-revision'
        }}
        selectedIds={['file:Content/Conflict.txt']}
        busy={false}
        refreshing={false}
        refreshAvailable={true}
        onRefresh={noop}
        onSelectionChange={noop}
        onStageFiles={noop}
        onStageAll={noop}
        onCreateRevision={noop}
        onOpenFile={noop}
        onExternalDiff={noop}
        onRevealFile={noop}
        onFileHistory={noop}
        onDiscardFiles={noop}
        onIgnoreFiles={noop}
        onSavePatch={noop}
        onConflictAction={noop}
        onAbortConflict={noop}
        onNotify={noop}
      />
    )

    expect(html).toContain('Merge conflict')
    expect(html).toContain('Mark resolved')
    expect(html).toContain('Use current version')
    expect(html).toContain('Use incoming version')
    expect(html).toContain('Regenerate selected conflicts')
    expect(html).toContain('Abort conflict operation')
    expect(html).toContain('class="local-changes has-conflicts"')
    expect(html).not.toContain('change-file-row__delta')
  })

  it('provides a default message and enables the final revision after all conflicts are resolved', () => {
    const noop = () => undefined
    const resolvedFiles: ChangeFile[] = [
      {
        ...files[0],
        id: 'Content/Conflict.txt',
        path: 'Content',
        name: 'Conflict.txt',
        binary: false,
        staged: true,
        conflict: true,
        conflictUnresolved: false
      }
    ]
    const html = renderToStaticMarkup(
      <LocalChanges
        repositoryPath="E:/Repositories/demo"
        repositoryIdentity="Arno <arno@example.com>"
        branches={branches}
        currentBranch="main"
        files={resolvedFiles}
        conflictSession={{
          kind: 'merge',
          currentRevision: 'current-revision',
          stagedRevision: 'staged-revision',
          incomingRevision: 'incoming-revision'
        }}
        selectedIds={['file:Content/Conflict.txt']}
        busy={false}
        refreshing={false}
        refreshAvailable={true}
        onRefresh={noop}
        onSelectionChange={noop}
        onStageFiles={noop}
        onStageAll={noop}
        onCreateRevision={noop}
        onOpenFile={noop}
        onExternalDiff={noop}
        onRevealFile={noop}
        onFileHistory={noop}
        onDiscardFiles={noop}
        onIgnoreFiles={noop}
        onSavePatch={noop}
        onConflictAction={noop}
        onAbortConflict={noop}
        onNotify={noop}
      />
    )

    expect(html).toContain('<textarea')
    expect(html).toContain('Resolve conflicts from merging feature into main</textarea>')
    expect(html).toContain('<button type="button">Commit</button>')
  })

  it('includes the source revision and target branch in the cherry-pick conflict message', () => {
    const noop = () => undefined
    const resolvedFiles: ChangeFile[] = [
      {
        ...files[0],
        id: 'Content/Conflict.txt',
        path: 'Content',
        name: 'Conflict.txt',
        binary: false,
        staged: true,
        conflict: true,
        conflictUnresolved: false
      }
    ]
    const html = renderToStaticMarkup(
      <LocalChanges
        repositoryPath="E:/Repositories/demo"
        repositoryIdentity="Arno <arno@example.com>"
        branches={branches}
        currentBranch="main"
        files={resolvedFiles}
        conflictSession={{
          kind: 'cherryPick',
          currentRevision: 'current-revision',
          stagedRevision: 'staged-revision',
          incomingRevision: 'incoming-revision'
        }}
        selectedIds={['file:Content/Conflict.txt']}
        busy={false}
        refreshing={false}
        refreshAvailable={true}
        onRefresh={noop}
        onSelectionChange={noop}
        onStageFiles={noop}
        onStageAll={noop}
        onCreateRevision={noop}
        onOpenFile={noop}
        onExternalDiff={noop}
        onRevealFile={noop}
        onFileHistory={noop}
        onDiscardFiles={noop}
        onIgnoreFiles={noop}
        onSavePatch={noop}
        onConflictAction={noop}
        onAbortConflict={noop}
        onNotify={noop}
      />
    )

    expect(html).toContain('Resolve conflicts from cherry-picking revision incoming onto main</textarea>')
    expect(html).toContain('<button type="button">Commit</button>')
  })
})
