import { useState } from 'react'
import { createRoot } from 'react-dom/client'

import { LocalChanges } from '../../src/features/local-changes/components/LocalChanges'
import { i18nReady } from '../../src/i18n'
import { initializeClientPreferences, updateClientPreferences } from '../../src/services/preferences'
import type { ChangeFile } from '../../src/types'

import '../../src/styles.css'

// An isolated browser fixture: the component and its callbacks are real, while
// only the repository data and mutation responses belong to this test.
const root = createRoot(document.getElementById('root')!)
const style = document.createElement('style')
style.textContent = '#root { width: 720px; height: 900px; } .local-changes { height: 100%; }'
document.head.append(style)
const noop = () => undefined
let generation = 0
let selected: string[] = []
let actions: Array<{ kind: string; ids: string[]; staged?: boolean }> = []

function Fixture({ initialFiles }: { initialFiles: ChangeFile[] }) {
  const [files, setFiles] = useState(initialFiles)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  return (
    <LocalChanges
      repositoryPath="/window-regression"
      repositoryIdentity="regression"
      branches={[]}
      currentBranch="main"
      files={files}
      fileLocks={[{ path: 'Content/group-0000/asset-000001.txt', branch: 'main', owner: 'owner', lockedAt: 1 }]}
      fileLockState="ready"
      lockAvailable
      conflictSession={null}
      selectedIds={selectedIds}
      busy={false}
      refreshing={false}
      refreshAvailable={false}
      onRefresh={noop}
      onSelectionChange={(ids) => {
        selected = ids
        setSelectedIds(ids)
      }}
      onStageFiles={(targets, staged) => {
        const ids = targets.map((file) => file.id)
        actions.push({ kind: 'stage', ids, staged })
        const accepted = new Set(ids)
        setFiles((current) => current.map((file) => (accepted.has(file.id) ? { ...file, staged } : file)))
      }}
      onStageAll={noop}
      onCreateRevision={noop}
      onOpenFile={noop}
      onExternalDiff={noop}
      onRevealFile={noop}
      onFileHistory={noop}
      onDiscardFiles={(targets) => actions.push({ kind: 'discard', ids: targets.map((file) => file.id) })}
      onIgnoreFiles={noop}
      onSavePatch={noop}
      onConflictAction={noop}
      onAbortConflict={noop}
      onNotify={noop}
    />
  )
}

async function settle() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

await i18nReady
await initializeClientPreferences()
Object.assign(window, {
  changeListFixture: {
    ready: true,
    state: () => ({ selected, actions }),
    async mount(count: number, mode: 'flat' | 'tree', decorated = false) {
      root.render(null)
      await settle()
      selected = []
      actions = []
      updateClientPreferences({ localChangesView: mode, language: 'en-US' })
      const files: ChangeFile[] = Array.from({ length: count }, (_, index) => ({
        id: `file-${index}`,
        path: `Content/group-${Math.floor(index / 100)
          .toString()
          .padStart(4, '0')}`,
        name: `asset-${index.toString().padStart(6, '0')}.txt`,
        status: decorated && index === 1 ? 'renamed' : 'modified',
        ...(decorated && index === 1 ? { previousPath: 'Content/original/old-name.txt' } : {}),
        ...(decorated && index === 2 ? { conflict: true, conflictUnresolved: true } : {}),
        staged: false,
        additions: 1,
        deletions: 0,
        contentClassification: { kind: 'text', source: 'utf8' }
      }))
      root.render(<Fixture key={++generation} initialFiles={files} />)
      await settle()
      return true
    }
  }
})
