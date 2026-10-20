type RepositoryRequestKind = 'open' | 'snapshot' | 'history' | 'mutation'

export interface RepositorySessionRequest {
  readonly path: string
  readonly session: number
  readonly generation: number
  readonly id: number
  readonly kind: RepositoryRequestKind
  readonly historyId: number
  readonly historyVersion: number
}

interface SessionRequests {
  session: number
  generation: number
  snapshotId: number
  historyId: number
  historyVersion: number
  mutationId: number
  mutating: boolean
}

/** Display paths already come from the native boundary; case is part of their identity. */
export function repositoryPathKey(path: string): string {
  return path.trim()
}

/**
 * Grants permission to publish an asynchronous result into one open session.
 * Closing/reopening and mutations invalidate old work even when native IPC cannot
 * be cancelled. Snapshot and history reads have separate latest-request slots.
 */
export class RepositorySessionRequests {
  private readonly sessions = new Map<string, SessionRequests>()
  private nextSession = 0
  private nextRequest = 0

  constructor(paths: readonly string[]) {
    this.retain(paths)
  }

  retain(paths: readonly string[]) {
    const retained = new Set(paths.map(repositoryPathKey))
    for (const path of this.sessions.keys()) {
      if (!retained.has(path)) this.sessions.delete(path)
    }
    for (const path of retained) {
      if (!this.sessions.has(path)) this.createSession(path)
    }
  }

  close(path: string) {
    this.sessions.delete(repositoryPathKey(path))
  }

  beginOpen(path: string): RepositorySessionRequest | null {
    const key = repositoryPathKey(path)
    if (this.sessions.get(key)?.mutating) return null
    this.createSession(key)
    return this.begin(key, 'open')
  }

  beginRead(path: string, kind: 'snapshot' | 'history'): RepositorySessionRequest | null {
    return this.begin(repositoryPathKey(path), kind)
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
      id,
      kind,
      historyId: session.historyId,
      historyVersion: session.historyVersion
    }
  }
}
