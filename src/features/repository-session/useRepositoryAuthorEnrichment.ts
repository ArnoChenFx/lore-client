import { useEffect, useState } from 'react'

import { useCurrentTime } from '../../hooks/useCurrentTime'
import { RepositoryAuthorNameResolver } from '../../services/lore'
import type { Repository, RepositoryAuthAccountBinding, RepositorySnapshot } from '../../types'
import { repositoryAuthorIdentities } from './repositoryAuthorNames'
import {
  repositoryPathKey,
  RepositorySessionRequests,
  type RepositorySessionRequest
} from './repositorySessionRequests'

interface AuthorNameResolver {
  hydrate: (
    identities: readonly string[],
    onNames: (names: ReadonlyMap<string, string>) => void,
    signal?: AbortSignal
  ) => Promise<void>
  dispose: () => void
}

type ApplyAuthorNames = (request: RepositorySessionRequest, names: ReadonlyMap<string, string>) => boolean
type CreateAuthorResolver = (repository: Repository, cacheScope: string) => AuthorNameResolver

interface AuthorScope {
  key: string
  resolver: AuthorNameResolver
  observer?: AbortController
}

/**
 * One owner for open tabs' optional author lookups. Native requests cannot be
 * cancelled, so both the scope and the session lease are checked before publishing.
 */
export class RepositoryAuthorEnrichment {
  private readonly scopes = new Map<string, AuthorScope>()

  constructor(
    private readonly requests: RepositorySessionRequests,
    private readonly applyNames: ApplyAuthorNames,
    private readonly createResolver: CreateAuthorResolver = (repository, cacheScope) =>
      new RepositoryAuthorNameResolver(repository, undefined, cacheScope)
  ) {}

  reconcile(
    snapshots: readonly RepositorySnapshot[],
    authStateVersion: number,
    bindings: readonly RepositoryAuthAccountBinding[]
  ): void {
    const retained = new Set<string>()
    for (const snapshot of snapshots) {
      const repository = snapshot.repository
      const path = repositoryPathKey(repository.path)
      const request = this.requests.beginAuthorLookup(path)
      if (!request) continue
      retained.add(path)
      const binding = bindings.find((candidate) => repositoryPathKey(candidate.repositoryPath) === path)
      // Commit identity is unrelated to the authenticated account. Stable scope is
      // also used to namespace disk hints; transient epochs only partition memory.
      const cacheScope = JSON.stringify([
        repository.id,
        path,
        repository.serverUrl ?? '',
        repository.remoteUrl ?? '',
        binding?.authUrl ?? '',
        binding?.userId ?? ''
      ])
      const key = JSON.stringify([
        cacheScope,
        request.session,
        request.generation,
        request.authorGeneration,
        authStateVersion,
        repository.online
      ])
      const identities = repositoryAuthorIdentities(snapshot)
      let scope = this.scopes.get(path)
      if (scope?.key !== key) {
        scope?.observer?.abort()
        scope?.resolver.dispose()
        scope = { key, resolver: this.createResolver(repository, cacheScope) }
        this.scopes.set(path, scope)
        // A new account or repository scope must not display an old scope's names
        // while its own optional lookup is pending.
        this.applyNames(request, new Map(identities.map((identity) => [identity, identity])))
      }
      const pendingScope = scope
      scope.observer?.abort()
      const observer = new AbortController()
      scope.observer = observer
      void scope.resolver.hydrate(
        identities,
        (names) => {
          if (!observer.signal.aborted && this.scopes.get(path) === pendingScope && this.requests.isCurrent(request)) {
            this.applyNames(request, names)
          }
        },
        observer.signal
      )
    }
    for (const [path, scope] of this.scopes) {
      if (retained.has(path)) continue
      scope.observer?.abort()
      scope.resolver.dispose()
      this.scopes.delete(path)
    }
  }

  dispose(): void {
    for (const scope of this.scopes.values()) {
      scope.observer?.abort()
      scope.resolver.dispose()
    }
    this.scopes.clear()
  }
}

interface UseRepositoryAuthorEnrichmentOptions {
  enabled: boolean
  snapshots: RepositorySnapshot[]
  authStateVersion: number
  bindings: RepositoryAuthAccountBinding[]
  requests: RepositorySessionRequests
  applyAuthorNames: ApplyAuthorNames
}

export function useRepositoryAuthorEnrichment({
  enabled,
  snapshots,
  authStateVersion,
  bindings,
  requests,
  applyAuthorNames
}: UseRepositoryAuthorEnrichmentOptions): void {
  const [enrichment] = useState(() => new RepositoryAuthorEnrichment(requests, applyAuthorNames))
  const now = useCurrentTime()
  useEffect(() => {
    enrichment.reconcile(enabled ? snapshots : [], authStateVersion, bindings)
  }, [enrichment, enabled, snapshots, authStateVersion, bindings, now])
  useEffect(() => () => enrichment.dispose(), [enrichment])
}
