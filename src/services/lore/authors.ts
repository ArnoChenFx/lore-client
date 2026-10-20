/** 修订与分支创建者的显示名解析，以及带缓存的作者名读写。 */
import type { OperationContext, Repository } from '../../types'
import { invokeLogged } from '../logging'
import { runOperation } from './core'
import { readKnownLoreLabel, readString } from './utils'

function containsIdentityControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x1f || codePoint === 0x7f) return true
  }
  return false
}

export interface AuthorNameResolverDependencies {
  loadCached: (repositoryId: string, identities: readonly string[]) => Promise<ReadonlyMap<string, string>>
  loadRemote: (repositoryPath: string, identities: readonly string[]) => Promise<ReadonlyMap<string, string>>
  loadLocal: (repositoryPath: string, identities: readonly string[]) => Promise<ReadonlyMap<string, string>>
  remember: (repositoryId: string, names: ReadonlyMap<string, string>) => Promise<void>
  now: () => number
}

interface AuthorNameListener {
  identities: ReadonlySet<string>
  onNames: (names: ReadonlyMap<string, string>) => void
  previous: Map<string, string>
}

const AUTHOR_FRESHNESS_MS = 5 * 60_000
const AUTHOR_RETRY_MS = 30_000
const MAX_AUTHOR_IDENTITIES_PER_REQUEST = 1_000

function validIdentity(identity: string): boolean {
  return Boolean(readKnownLoreLabel(identity)) && identity.length <= 512 && !containsIdentityControlCharacter(identity)
}

/** Even cache and Auth responses must not introduce identities absent from this request. */
function requestedAuthorNames(names: ReadonlyMap<string, string>, identities: readonly string[]): Map<string, string> {
  const requested = new Set(identities)
  const resolved = new Map<string, string>()
  for (const [identity, value] of names) {
    const name = value.trim()
    if (
      requested.has(identity) &&
      name &&
      name !== identity &&
      name.length <= 512 &&
      !containsIdentityControlCharacter(name)
    ) {
      resolved.set(identity, name)
    }
  }
  return resolved
}

async function loadAuthAuthorNames(
  repositoryPath: string,
  identities: readonly string[],
  command: 'lore_auth_user_info' | 'lore_auth_repository_local_user_info',
  operationContext?: OperationContext
): Promise<Map<string, string>> {
  const result = await runOperation(command, { repositoryPath, userIds: identities }, operationContext)
  return requestedAuthorNames(
    new Map(
      result.events
        .filter((event) => event.tagName === 'authUserInfo')
        .map((event) => [readString(event.data.id).trim(), readString(event.data.name)])
    ),
    identities
  )
}

const defaultDependencies: AuthorNameResolverDependencies = {
  loadCached: loadCachedAuthorNames,
  loadRemote: (path, identities) => loadAuthAuthorNames(path, identities, 'lore_auth_user_info'),
  loadLocal: (path, identities) => loadAuthAuthorNames(path, identities, 'lore_auth_repository_local_user_info'),
  remember: rememberAuthorNames,
  now: Date.now
}

/**
 * The native cache key is bounded to 512 characters. Hash the durable repository
 * and authentication scope instead of storing long paths or using an unscoped fallback.
 */
async function scopedCacheKey(repositoryId: string, scope: string): Promise<string | null> {
  try {
    if (!globalThis.crypto?.subtle) return null
    const value = new TextEncoder().encode(JSON.stringify([repositoryId, scope]))
    const digest = await globalThis.crypto.subtle.digest('SHA-256', value)
    return `author-scope-v1:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
  } catch {
    return null
  }
}

/**
 * One owner creates this resolver for one repository/authentication scope.
 * Cache and Auth work only enrich already-visible facts; no global names survive
 * disposal. Each identity owns its freshness and pending request, so overlapping
 * history pages share lookups without repeatedly querying free-form identities.
 */
export class RepositoryAuthorNameResolver {
  private readonly dependencies: AuthorNameResolverDependencies
  private readonly cacheRepositoryId: Promise<string | null>
  private readonly names = new Map<string, string>()
  private readonly freshUntil = new Map<string, number>()
  private readonly inFlight = new Map<string, Promise<void>>()
  private readonly listeners = new Set<AuthorNameListener>()
  private disposed = false

  constructor(
    private readonly repository: Repository,
    cacheScope: string,
    dependencies: Partial<AuthorNameResolverDependencies> = {}
  ) {
    this.dependencies = { ...defaultDependencies, ...dependencies }
    this.cacheRepositoryId = scopedCacheKey(repository.id, cacheScope)
  }

  async hydrate(
    identityCandidates: readonly string[],
    onNames: (names: ReadonlyMap<string, string>) => void,
    signal?: AbortSignal
  ): Promise<void> {
    if (this.disposed || signal?.aborted) return
    const identities = [...new Set(identityCandidates.filter(validIdentity))]
    if (identities.length === 0) return
    const listener: AuthorNameListener = { identities: new Set(identities), onNames, previous: new Map() }
    this.listeners.add(listener)
    let completeAbort: (() => void) | undefined
    const abortObserver = () => {
      this.listeners.delete(listener)
      completeAbort?.()
    }
    const aborted = signal
      ? new Promise<void>((resolve) => {
          completeAbort = resolve
          signal.addEventListener('abort', abortObserver, { once: true })
        })
      : null
    try {
      this.publish(listener)
      if (signal?.aborted || this.disposed) return
      const now = this.dependencies.now()
      const missing = identities.filter(
        (identity) => !this.inFlight.has(identity) && (this.freshUntil.get(identity) ?? 0) <= now
      )
      for (let offset = 0; offset < missing.length; offset += MAX_AUTHOR_IDENTITIES_PER_REQUEST) {
        // History alone may contain 1,000 distinct authors; branch creators can
        // add more. Both native Auth and cache commands enforce this batch limit.
        const batch = missing.slice(offset, offset + MAX_AUTHOR_IDENTITIES_PER_REQUEST)
        const task = this.refresh(batch).finally(() => {
          for (const identity of batch) {
            if (this.inFlight.get(identity) === task) this.inFlight.delete(identity)
          }
        })
        for (const identity of batch) this.inFlight.set(identity, task)
      }
      const pending = Promise.all(new Set(identities.flatMap((identity) => this.inFlight.get(identity) ?? [])))
      // Cancelling an observer releases UI closures, while the request remains
      // shared by a later snapshot's observer until its owning scope is disposed.
      await (aborted ? Promise.race([pending, aborted]) : pending)
    } finally {
      this.listeners.delete(listener)
      signal?.removeEventListener('abort', abortObserver)
    }
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
    this.names.clear()
    this.freshUntil.clear()
    this.inFlight.clear()
  }

  private publish(listener: AuthorNameListener): void {
    if (this.disposed) return
    const names = new Map<string, string>()
    for (const identity of listener.identities) {
      const name = this.names.get(identity)
      if (name) names.set(identity, name)
    }
    if (
      names.size === listener.previous.size &&
      [...names].every(([identity, name]) => listener.previous.get(identity) === name)
    ) {
      return
    }
    listener.previous = names
    listener.onNames(names)
  }

  private publishNames(): void {
    for (const listener of this.listeners) this.publish(listener)
  }

  private async refresh(identities: readonly string[]): Promise<void> {
    const cacheRepositoryId = await this.cacheRepositoryId
    if (this.disposed) return
    if (cacheRepositoryId) {
      try {
        const cached = requestedAuthorNames(
          await this.dependencies.loadCached(cacheRepositoryId, identities),
          identities
        )
        if (this.disposed) return
        // A late or outdated disk cache must not replace a name already confirmed in memory.
        for (const [identity, name] of cached) {
          if (!this.names.has(identity)) this.names.set(identity, name)
        }
        this.publishNames()
      } catch {
        // A damaged or unavailable optional cache cannot prevent a direct Auth lookup.
      }
    }
    if (this.disposed) return
    let resolved: Map<string, string> | undefined
    if (this.repository.online) {
      try {
        resolved = requestedAuthorNames(
          await this.dependencies.loadRemote(this.repository.path, identities),
          identities
        )
      } catch {
        // The local command only exposes the repository's bound account, never a guessed identity.
      }
    }
    if (this.disposed) return
    if (!resolved) {
      try {
        resolved = requestedAuthorNames(await this.dependencies.loadLocal(this.repository.path, identities), identities)
      } catch {
        // Missing accounts and unavailable Auth leave historical identities and cached names usable.
      }
    }
    if (this.disposed) return
    const now = this.dependencies.now()
    for (const identity of identities) {
      const name = resolved?.get(identity)
      if (name) this.names.set(identity, name)
      this.freshUntil.set(identity, now + (name ? AUTHOR_FRESHNESS_MS : AUTHOR_RETRY_MS))
    }
    this.publishNames()
    if (!this.disposed && cacheRepositoryId && resolved?.size) {
      // Persisting is also optional; a slow write cannot hold the lookup's in-flight slot indefinitely.
      void this.dependencies.remember(cacheRepositoryId, resolved).catch(() => undefined)
    }
  }
}

type AuthorCacheEntry = {
  userId: string
  displayName: string
}

/** 独立缓存文件损坏或不可读不能阻断历史读取；失败时退回 Revision 原始 identity。 */
async function loadCachedAuthorNames(
  repositoryId: string,
  userIds: readonly string[],
  operationContext?: OperationContext
): Promise<Map<string, string>> {
  try {
    const entries = await invokeLogged<AuthorCacheEntry[]>(
      'lore_revision_author_cache_get',
      {
        repositoryId,
        userIds
      },
      operationContext
    )
    return new Map(entries.map((entry) => [entry.userId, entry.displayName]))
  } catch {
    return new Map()
  }
}

/** 只把 Auth 已确认的显示名交给 Rust；Token、JWT 与头像地址从不进入该 IPC。 */
async function rememberAuthorNames(
  repositoryId: string,
  resolvedNames: ReadonlyMap<string, string>,
  operationContext?: OperationContext
): Promise<void> {
  if (resolvedNames.size === 0) return
  try {
    await invokeLogged(
      'lore_revision_author_cache_store',
      {
        repositoryId,
        authors: [...resolvedNames].map(([userId, displayName]) => ({ userId, displayName }))
      },
      operationContext
    )
  } catch {
    // 显示缓存属于尽力增强；写盘失败不能把成功的在线作者查询降级为操作失败。
  }
}
