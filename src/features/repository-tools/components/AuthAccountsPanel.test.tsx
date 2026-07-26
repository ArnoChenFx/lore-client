import { describe, expect, it } from 'vitest'

import { consolidateAuthIdentities } from './AuthAccountsPanel'

describe('auth accounts panel', () => {
  it('consolidates authentication and resource entries for one account', () => {
    const accounts = consolidateAuthIdentities([
      {
        authUrl: 'https://auth.example.com',
        userId: 'user-1',
        resource: '',
        authorizedDomains: ['example.com']
      },
      {
        authUrl: 'https://auth.example.com',
        userId: 'user-1',
        resource: 'lore://server/repository',
        authorizedDomains: ['server.example.com']
      }
    ])

    expect(accounts).toHaveLength(1)
    expect(accounts[0].authorizedDomains).toEqual(['example.com', 'server.example.com'])
    expect(accounts[0].resource).toBe('lore://server/repository')
  })
})
