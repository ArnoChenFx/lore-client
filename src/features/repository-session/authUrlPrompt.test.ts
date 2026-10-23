import { describe, expect, it } from 'bun:test'

import type { LoreAuthUrlEvent } from '../../services/lore'
import { applyAuthUrlDismiss, applyAuthUrlEvent } from './authUrlPrompt'

const firstEvent: LoreAuthUrlEvent = {
  operationId: 'lore-operation-1',
  operation: 'auth.login-interactive',
  url: 'https://auth.example/device',
  userCode: 'WDJB-8KQT'
}

const secondEvent: LoreAuthUrlEvent = {
  operationId: 'lore-operation-2',
  operation: 'auth.login-interactive',
  url: 'https://auth.example/device',
  userCode: 'PLMZ-42XA'
}

describe('authUrlPrompt state transitions', () => {
  it('shows the latest AuthUrl event, replacing any earlier prompt', () => {
    const first = applyAuthUrlEvent(null, firstEvent)
    expect(first).toEqual({
      operationId: 'lore-operation-1',
      operation: 'auth.login-interactive',
      url: 'https://auth.example/device',
      userCode: 'WDJB-8KQT'
    })

    const second = applyAuthUrlEvent(first, secondEvent)
    expect(second?.operationId).toBe('lore-operation-2')
    expect(second?.userCode).toBe('PLMZ-42XA')
  })

  it('dismisses only the prompt of the operation that ended', () => {
    const current = applyAuthUrlEvent(null, secondEvent)
    expect(applyAuthUrlDismiss(current, { operationId: 'lore-operation-1' })).toBe(current)
    expect(applyAuthUrlDismiss(current, { operationId: 'lore-operation-2' })).toBeNull()
    expect(applyAuthUrlDismiss(null, { operationId: 'lore-operation-2' })).toBeNull()
  })
})
