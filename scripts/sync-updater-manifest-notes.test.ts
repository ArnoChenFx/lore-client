import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { synchronizeUpdaterManifestNotes } from './sync-updater-manifest-notes.mjs'

const projectRoot = resolve(import.meta.dirname, '..')

describe('release updater manifest notes synchronization', () => {
  test('replaces placeholder notes while preserving updater artifacts', () => {
    const source = JSON.stringify({
      version: '0.2.0',
      notes: 'Release notes are generated after all platform artifacts have been uploaded.',
      pub_date: '2026-07-30T08:44:20.935Z',
      platforms: {
        'windows-x86_64': {
          signature: 'signed',
          url: 'https://example.test/installer.exe'
        }
      }
    })
    const notes = '## Changes\n\n- Fix updater release notes'

    const result = JSON.parse(synchronizeUpdaterManifestNotes(source, notes, 'v0.2.0'))

    expect(result.notes).toBe(notes)
    expect(result.version).toBe('0.2.0')
    expect(result.platforms['windows-x86_64']).toEqual({
      signature: 'signed',
      url: 'https://example.test/installer.exe'
    })
  })

  test('rejects a manifest from another release', () => {
    const source = JSON.stringify({ version: '0.2.1', notes: 'Draft', platforms: {} })

    expect(() => synchronizeUpdaterManifestNotes(source, '## Changes', 'v0.2.0')).toThrow(
      'expected 0.2.0, received 0.2.1'
    )
  })

  test('synchronizes final release notes before publishing the GitHub release', async () => {
    const workflow = await readFile(resolve(projectRoot, '.github', 'workflows', 'release.yml'), 'utf8')
    const synchronizeIndex = workflow.indexOf('sync-updater-manifest-notes.mjs')
    const uploadIndex = workflow.indexOf(
      'gh release upload "${{ github.ref_name }}" updater-manifest/latest.json --clobber'
    )
    const publishIndex = workflow.indexOf(
      'gh release edit "${{ github.ref_name }}" --notes-file release-notes.md --draft=false'
    )

    // 这个顺序断言覆盖真实故障：Release 正文已更新，但客户端读取的 latest.json 仍是占位说明。
    expect(synchronizeIndex).toBeGreaterThan(-1)
    expect(uploadIndex).toBeGreaterThan(synchronizeIndex)
    expect(publishIndex).toBeGreaterThan(uploadIndex)
  })
})
