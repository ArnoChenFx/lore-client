import { describe, expect, it } from 'vitest'

import { consolidateAuthIdentities, sortRepositoriesForAccountBinding } from './AuthAccountsPanel'

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

  it('sorts repository bindings by name with stable path and identifier tie breakers', () => {
    const repositories = [
      { id: 'zulu', name: 'test-new-repo', path: 'E:\\Repos\\test-new-repo' },
      { id: 'alpha-b', name: 'test-lore-repo', path: 'E:\\Repos\\B\\test-lore-repo' },
      { id: 'alpha-a', name: 'test-lore-repo', path: 'E:\\Repos\\A\\test-lore-repo' },
      { id: 'alpha-uppercase', name: 'Test-Lore-Repo', path: 'E:\\Repos\\Z\\test-lore-repo' }
    ]

    expect(sortRepositoriesForAccountBinding(repositories).map((repository) => repository.id)).toEqual([
      'alpha-uppercase',
      'alpha-a',
      'alpha-b',
      'zulu'
    ])
    expect(repositories.map((repository) => repository.id)).toEqual(['zulu', 'alpha-b', 'alpha-a', 'alpha-uppercase'])
  })
})
