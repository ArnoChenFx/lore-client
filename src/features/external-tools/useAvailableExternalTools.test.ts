import { describe, expect, it } from 'vitest'

import type { ExternalDiffToolPreference } from '../../types'
import { collectExternalToolCandidates, selectAvailableExternalTools } from './useAvailableExternalTools'

function tool(
  id: string,
  mode: 'diff' | 'merge',
  options: Partial<ExternalDiffToolPreference> = {}
): ExternalDiffToolPreference {
  return {
    id,
    kind: 'custom',
    name: id,
    executable: `${id}.exe`,
    arguments:
      mode === 'diff'
        ? ['{before}', '{after}', '{beforeLabel}', '{afterLabel}']
        : ['{base}', '{local}', '{remote}', '{merged}'],
    primary: false,
    ...options
  }
}

describe('available external tools controller', () => {
  it('validates Diff and Merge candidates with their own templates', () => {
    const duplicateId = 'shared-id'
    const preferences = {
      externalDiffTools: [tool(duplicateId, 'diff')],
      externalMergeTools: [tool(duplicateId, 'merge')]
    }

    expect(collectExternalToolCandidates(preferences)).toEqual([
      expect.objectContaining({ id: duplicateId, arguments: expect.arrayContaining(['{before}']) }),
      expect.objectContaining({ id: duplicateId, arguments: expect.arrayContaining(['{base}']) })
    ])
  })

  it('excludes unavailable and incomplete tools while keeping the primary tool first', () => {
    const preferences = {
      externalDiffTools: [
        tool('secondary', 'diff'),
        tool('primary', 'diff', { primary: true }),
        tool('missing', 'diff'),
        tool('incomplete', 'diff', { arguments: ['{before}'] })
      ],
      externalMergeTools: [tool('merge', 'merge')]
    }

    const available = selectAvailableExternalTools(preferences, ['secondary', 'primary', 'incomplete', 'merge'])

    expect(available.availableExternalDiffTools.map((item) => item.id)).toEqual(['primary', 'secondary'])
    expect(available.availableExternalMergeTools.map((item) => item.id)).toEqual(['merge'])
  })
})
