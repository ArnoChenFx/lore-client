import { useState } from 'react'
import { createRoot } from 'react-dom/client'

import { LocalChanges } from '../../src/features/local-changes/components/LocalChanges'
import { i18nReady } from '../../src/i18n'
import { updateClientPreferences } from '../../src/services/preferences'
import type { ChangeFile } from '../../src/types'

import '../../src/styles.css'

// This entry is built only by the measurement script. It exercises the real
// component, styles and preference store without adding a production test API.
const root = createRoot(document.getElementById('root')!)
const style = document.createElement('style')
style.textContent = '#root { width: 720px; height: 900px; } .local-changes { height: 100%; }'
document.head.append(style)
const noop = () => undefined
let generation = 0

function Fixture({ files }: { files: ChangeFile[] }) {
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  return (
    <LocalChanges
      repositoryPath="/performance-fixture"
      repositoryIdentity="benchmark"
      branches={[]}
      currentBranch="main"
      files={files}
      conflictSession={null}
      selectedIds={selectedIds}
      busy={false}
      refreshing={false}
      refreshAvailable={false}
      onRefresh={noop}
      onSelectionChange={setSelectedIds}
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
}

function filesFor(count: number): ChangeFile[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `file-${index}`,
    path: `Content/group-${Math.floor(index / 100)
      .toString()
      .padStart(4, '0')}`,
    name: `asset-${index.toString().padStart(6, '0')}.txt`,
    status: 'modified',
    staged: false,
    additions: 1,
    deletions: 0,
    size: '1 KB',
    contentClassification: { kind: 'text', source: 'utf8' }
  }))
}

function afterFrames() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

function visibleFileCount() {
  return [...document.querySelectorAll('.local-changes__summary b')].reduce(
    (count, element) => count + Number(element.textContent),
    0
  )
}

async function until(condition: () => boolean) {
  const deadline = performance.now() + 60_000
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('The fixture did not reach its expected DOM state')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  await afterFrames()
}

let action: { start: number; result: { durationMs: number; rows: number } | null } | null = null
let armed: { event: 'click' | 'input'; expected: () => boolean } | null = null
for (const type of ['click', 'input'] as const) {
  document.addEventListener(
    type,
    () => {
      if (!armed || armed.event !== type) return
      const { expected } = armed
      armed = null
      action = { start: performance.now(), result: null }
      const active = action
      void until(expected).then(() => {
        active.result = {
          durationMs: performance.now() - active.start,
          rows: document.querySelectorAll('.change-file-row').length
        }
      })
    },
    { capture: true }
  )
}

await i18nReady
Object.assign(window, {
  localChangesBenchmark: {
    ready: true,
    async mount(count: number, mode: 'flat' | 'tree') {
      root.render(null)
      await until(() => document.querySelector('.local-changes') === null)
      updateClientPreferences({ localChangesView: mode, language: 'en-US' })
      const files = filesFor(count)
      // Fixture creation and previous unmount are intentionally outside mount time.
      const start = performance.now()
      root.render(<Fixture key={++generation} files={files} />)
      await until(() => visibleFileCount() === count && document.querySelector('.change-file-row') !== null)
      return {
        durationMs: performance.now() - start,
        matchingFiles: visibleFileCount(),
        rows: document.querySelectorAll('.change-file-row').length,
        elements: document.querySelectorAll('*').length
      }
    },
    async geometry(mode: 'flat' | 'tree') {
      const files = filesFor(2)
      files[1] = {
        ...files[1],
        name: 'renamed-with-a-long-display-name.txt',
        status: 'renamed',
        previousPath: 'Content/original-location/original-name.txt'
      }
      root.render(null)
      await until(() => document.querySelector('.local-changes') === null)
      updateClientPreferences({ localChangesView: mode })
      root.render(<Fixture key={++generation} files={files} />)
      await until(() => document.querySelectorAll('.change-file-row').length === 2)
      return [...document.querySelectorAll('.change-file-row, .change-directory-row')].map((row) => ({
        kind: row.classList.contains('change-directory-row') ? 'directory' : 'file',
        text: row.textContent,
        height: row.getBoundingClientRect().height
      }))
    },
    armSelection(name: string) {
      action = null
      armed = {
        event: 'click',
        expected: () =>
          [...document.querySelectorAll('.change-file-row[aria-selected="true"]')].some((row) =>
            row.textContent?.includes(name)
          )
      }
    },
    armFilter(expectedFiles: number) {
      action = null
      armed = {
        event: 'input',
        expected: () => visibleFileCount() === expectedFiles
      }
    },
    result() {
      return action?.result ?? null
    }
  }
})
