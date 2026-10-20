import { repositoryPathKey } from '../../shared/lib'

type RepositoryRequestKind = 'open' | 'snapshot' | 'history' | 'mutation' | 'authors'

export interface RepositorySessionRequest {
  readonly path: string
  readonly session: number
  readonly generation: number
  readonly authorGeneration: number
  readonly id: number
  readonly kind: RepositoryRequestKind
  readonly historyId: number
  readonly historyVersion: number
}

interface SessionRequests {
  session: number
  generation: number
  authorGeneration: number
  snapshotId: number
  historyId: number
  historyVersion: number
  mutationId: number
  mutating: boolean
}

/**
 * Grants permission to publish an asynchronous result into one open session.
 * Closing/reopening and mutations invalidate old work even when native IPC cannot
 * be cancelled. Snapshot and history reads have separate latest-request slots.
 */
export class RepositorySessionRequests {
  private readonly sessions = new Map<string, SessionRequests>()
  // Native contexts belong to a path even while its tab is closed or replaced.
  private readonly authorAuthenticationRefreshes = new Map<string, number>()
  private nextSession = 0
  private nextRequest = 0
  private interactionVersion = 0

  constructor(paths: readonly string[]) {
    this.retain(paths)
  }

  retain(paths: readonly string[]) {
    this.interactionVersion += 1
    const retained = new Set(paths.map(repositoryPathKey))
    for (const path of this.sessions.keys()) {
      if (!retained.has(path)) this.sessions.delete(path)
    }
    for (const path of retained) {
      if (!this.sessions.has(path)) this.createSession(path)
    }
  }

  close(path: string) {
    this.interactionVersion += 1
    this.sessions.delete(repositoryPathKey(path))
  }

  beginOpen(path: string): RepositorySessionRequest | null {
    const key = repositoryPathKey(path)
    if (this.sessions.get(key)?.mutating) return null
    this.interactionVersion += 1
    this.createSession(key)
    return this.begin(key, 'open')
  }

  /** Startup restoration may replace the session only until the user changes it. */
  captureRestoreIntent(): number {
    return this.interactionVersion
  }

  isRestoreIntentCurrent(version: number): boolean {
    return this.interactionVersion === version
  }

  beginRead(path: string, kind: 'snapshot' | 'history'): RepositorySessionRequest | null {
    return this.begin(repositoryPathKey(path), kind)
  }

  /** Display enrichment observes the current generation without superseding core reads. */
  beginAuthorLookup(path: string): RepositorySessionRequest | null {
    const key = repositoryPathKey(path)
    const session = this.sessions.get(key)
    if (!session || session.mutating || this.authorAuthenticationRefreshes.has(key)) return null
    return this.request(key, session, 'authors', session.snapshotId)
  }

  /** Auth contexts change before the UI's auth version advances; do not attach fresh observers to old work. */
  pauseAuthorLookupsForAuthentication(path: string): () => void {
    const key = repositoryPathKey(path)
    const session = this.sessions.get(key)
    if (session) session.authorGeneration += 1
    this.authorAuthenticationRefreshes.set(key, (this.authorAuthenticationRefreshes.get(key) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (this.authorAuthenticationRefreshes.get(key) ?? 1) - 1
      if (remaining > 0) this.authorAuthenticationRefreshes.set(key, remaining)
      else this.authorAuthenticationRefreshes.delete(key)
    }
  }

  beginMutation(path: string): RepositorySessionRequest | null {
    const key = repositoryPathKey(path)
    const session = this.sessions.get(key)
    if (!session || session.mutating) return null
    session.generation += 1
    session.mutating = true
    session.mutationId = ++this.nextRequest
    return this.request(key, session, 'mutation', session.mutationId)
  }

  finishMutation(request: RepositorySessionRequest) {
    if (!this.isCurrent(request)) return
    this.sessions.get(request.path)!.mutating = false
  }

  isCurrent(request: RepositorySessionRequest): boolean {
    const session = this.sessions.get(request.path)
    if (!session || session.session !== request.session || session.generation !== request.generation) return false
    if (
      request.kind === 'authors' &&
      (session.authorGeneration !== request.authorGeneration || this.authorAuthenticationRefreshes.has(request.path))
    ) {
      return false
    }
    const currentId =
      request.kind === 'history'
        ? session.historyId
        : request.kind === 'mutation'
          ? session.mutationId
          : session.snapshotId
    return currentId === request.id
  }

  hasNewerHistory(request: RepositorySessionRequest): boolean {
    const session = this.sessions.get(request.path)
    return session?.historyId !== request.historyId || session.historyVersion !== request.historyVersion
  }

  invalidateHistory(path: string) {
    const session = this.sessions.get(repositoryPathKey(path))
    if (session) session.historyId = ++this.nextRequest
  }

  didApplyHistory(request: RepositorySessionRequest) {
    if (this.isCurrent(request)) this.sessions.get(request.path)!.historyVersion += 1
  }

  private createSession(path: string) {
    this.sessions.set(path, {
      session: ++this.nextSession,
      generation: 0,
      authorGeneration: 0,
      snapshotId: 0,
      historyId: 0,
      historyVersion: 0,
      mutationId: 0,
      mutating: false
    })
  }

  private begin(path: string, kind: 'open' | 'snapshot' | 'history'): RepositorySessionRequest | null {
    const session = this.sessions.get(path)
    if (!session || session.mutating) return null
    const id = ++this.nextRequest
    if (kind === 'history') session.historyId = id
    else session.snapshotId = id
    return this.request(path, session, kind, id)
  }

  private request(path: string, session: SessionRequests, kind: RepositoryRequestKind, id: number) {
    return {
      path,
      session: session.session,
      generation: session.generation,
      authorGeneration: session.authorGeneration,
      id,
      kind,
      historyId: session.historyId,
      historyVersion: session.historyVersion
    }
  }
}
