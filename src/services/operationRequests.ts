import type { OperationContext } from '../types'

export type OperationRequestEvent = {
  type: 'started' | 'finished'
  context: OperationContext
}

interface ActiveRequest {
  context: OperationContext
  leases: number
}

const activeRequests = new Map<string, ActiveRequest>()
const listeners = new Set<(event: OperationRequestEvent) => void>()

/** A new request belongs to one workspace for its entire lifetime, including retries and refreshes. */
export function createOperationContext(workspaceKey: string | null): OperationContext {
  return Object.freeze({ requestId: crypto.randomUUID(), workspaceKey })
}

function publish(event: OperationRequestEvent): void {
  // Observers added during this notification start with the next event.
  const currentListeners = [...listeners]
  for (const listener of currentListeners) {
    try {
      listener(event)
    } catch (error) {
      // An observer must not prevent an IPC call or leak its lifetime registration.
      console.error('Failed to observe an operation request', error)
    }
  }
}

/**
 * Register an explicit scope or IPC call. This stores live owners only: it never
 * supplies an ambient "current request" across asynchronous calls.
 */
export function acquireOperationRequest(context: OperationContext): () => void {
  const existing = activeRequests.get(context.requestId)
  if (existing && existing.context.workspaceKey !== context.workspaceKey) {
    throw new Error('An operation request cannot change its workspace owner')
  }
  const request = existing ?? {
    context: Object.freeze({ requestId: context.requestId, workspaceKey: context.workspaceKey }),
    leases: 0
  }
  request.leases += 1
  if (!existing) {
    activeRequests.set(context.requestId, request)
    publish({ type: 'started', context: request.context })
  }
  let released = false
  return () => {
    if (released) return
    released = true
    request.leases -= 1
    if (request.leases === 0) {
      activeRequests.delete(request.context.requestId)
      publish({ type: 'finished', context: request.context })
    }
  }
}

/** Keep a composite request alive between its explicitly associated child calls. */
export async function withOperationRequest<T>(
  context: OperationContext,
  task: (context: OperationContext) => Promise<T>
): Promise<T> {
  const release = acquireOperationRequest(context)
  try {
    return await task(context)
  } finally {
    release()
  }
}

/** New observers read this after subscribing so already-running requests are included. */
export function getActiveOperationRequests(): OperationContext[] {
  return [...activeRequests.values()].map((request) => request.context)
}

export function subscribeOperationRequests(listener: (event: OperationRequestEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
