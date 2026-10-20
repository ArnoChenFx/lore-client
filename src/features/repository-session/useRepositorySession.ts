import { useCallback, useRef, useState } from 'react'

import type { RepositorySnapshot, Revision } from '../../types'
import { reorderItemsById } from './components/repositoryTabsModel'
import { updateRepositoryAuthorNames } from './repositoryAuthorNames'
import {
  repositoryPathKey,
  RepositorySessionRequests,
  type RepositorySessionRequest
} from './repositorySessionRequests'

interface InitialRepositorySelection {
  revisionId?: string
  branchId?: string
  tagId?: string
}

interface RepositorySelection {
  revisionId: string
  branchId: string
  tagId: string
}

/** 从真实快照计算激活仓库时的稳定默认选区。 */
export function repositorySelection(snapshot: RepositorySnapshot): RepositorySelection {
  return {
    revisionId: snapshot.repository.revision || snapshot.revisions[0]?.id || '',
    branchId: snapshot.branches.find((branch) => branch.current)?.id ?? snapshot.branches[0]?.id ?? '',
    tagId: snapshot.tags[0]?.id ?? ''
  }
}

/**
 * 会话 Tab 的身份必须对应本地工作区，而不是 Lore 仓库 ID。
 *
 * 用户可以把同一个远端仓库克隆到多个目录；这些副本共享 Lore ID，却拥有独立的文件、
 * 工作区状态和窗口 Tab。保留原生层返回路径的大小写，避免合并大小写敏感的工作区。
 */
export function repositorySessionKey(snapshot: RepositorySnapshot): string {
  return repositoryPathKey(snapshot.repository.path)
}

/**
 * 使用 Lore 返回的新快照替换同一仓库。
 *
 * 本地工作区路径是主键；同一 Lore ID 的不同目录必须保持为独立 Tab。
 */
export function upsertRepositorySnapshot(
  snapshots: RepositorySnapshot[],
  nextSnapshot: RepositorySnapshot
): RepositorySnapshot[] {
  const nextSessionKey = repositorySessionKey(nextSnapshot)
  const index = snapshots.findIndex((snapshot) => repositorySessionKey(snapshot) === nextSessionKey)
  if (index < 0) return [...snapshots, nextSnapshot]
  return snapshots.map((snapshot, snapshotIndex) => (snapshotIndex === index ? nextSnapshot : snapshot))
}

/** A history response only owns revisions, never the other fields it originally read. */
export function updateRepositoryHistory(
  snapshots: RepositorySnapshot[],
  path: string,
  revisions: Revision[]
): RepositorySnapshot[] {
  return snapshots.map((snapshot) =>
    repositorySessionKey(snapshot) === repositoryPathKey(path) ? { ...snapshot, revisions } : snapshot
  )
}

/** History queries and their branch pointers depend on these fields, not author labels. */
function sameHistoryContext(left: RepositorySnapshot, right: RepositorySnapshot): boolean {
  if (left.repository.branch !== right.repository.branch || left.repository.revision !== right.repository.revision) {
    return false
  }
  if (left.branches.length !== right.branches.length) return false
  const branches = new Map(right.branches.map((branch) => [branch.id, branch]))
  return left.branches.every((branch) => {
    const other = branches.get(branch.id)
    return (
      other &&
      branch.name === other.name &&
      branch.latest === other.latest &&
      Boolean(branch.current) === Boolean(other.current) &&
      Boolean(branch.remote) === Boolean(other.remote) &&
      Boolean(branch.archived) === Boolean(other.archived)
    )
  })
}

/**
 * 管理多仓库会话及各对象类型的当前选区。
 *
 * 这里只维护前端稳定 DTO 和会话选择，不读取偏好、不调用 Lore，也不负责服务器浏览
 * 草稿。跨领域副作用由 App 在调用 `activateSnapshot` 后显式执行。
 */
export function useRepositorySession(
  initialSnapshots: RepositorySnapshot[],
  initialSelection: InitialRepositorySelection = {}
) {
  const initialSnapshot = initialSnapshots[0]
  const snapshotSelection = initialSnapshot ? repositorySelection(initialSnapshot) : null
  const [snapshots, setSnapshots] = useState<RepositorySnapshot[]>(initialSnapshots)
  // Event/IPC callbacks can run before React renders again (e.g. two closes).
  const currentSnapshots = useRef(initialSnapshots)
  const publishSnapshots = useCallback((next: RepositorySnapshot[]) => {
    currentSnapshots.current = next
    setSnapshots(next)
  }, [])
  const [activeRepositoryId, setActiveRepositoryId] = useState(
    initialSnapshot ? repositorySessionKey(initialSnapshot) : ''
  )
  const [selectedRevisionId, setSelectedRevisionId] = useState(
    snapshotSelection?.revisionId ?? initialSelection.revisionId ?? ''
  )
  const [selectedBranchId, setSelectedBranchId] = useState(
    snapshotSelection?.branchId ?? initialSelection.branchId ?? ''
  )
  const [selectedTagId, setSelectedTagId] = useState(snapshotSelection?.tagId ?? initialSelection.tagId ?? '')
  const [unavailableRepositoryPaths, setUnavailableRepositoryPaths] = useState<string[]>([])
  const [requests] = useState(
    () => new RepositorySessionRequests(initialSnapshots.map((snapshot) => snapshot.repository.path))
  )
  const activeSessionKey = useRef(initialSnapshot ? repositorySessionKey(initialSnapshot) : '')

  const activateRepositorySnapshot = useCallback((snapshot: RepositorySnapshot) => {
    const selection = repositorySelection(snapshot)
    activeSessionKey.current = repositorySessionKey(snapshot)
    setActiveRepositoryId(repositorySessionKey(snapshot))
    setSelectedRevisionId(selection.revisionId)
    setSelectedBranchId(selection.branchId)
    setSelectedTagId(selection.tagId)
  }, [])

  const upsertSnapshot = useCallback(
    (nextSnapshot: RepositorySnapshot) => {
      setUnavailableRepositoryPaths((current) =>
        current.filter((path) => repositoryPathKey(path) !== repositorySessionKey(nextSnapshot))
      )
      // Synchronous demo projections may update existing tabs, but cannot reopen closed ones.
      const current = currentSnapshots.current
      if (current.some((snapshot) => repositorySessionKey(snapshot) === repositorySessionKey(nextSnapshot))) {
        publishSnapshots(upsertRepositorySnapshot(current, nextSnapshot))
      }
    },
    [publishSnapshots]
  )

  const applySnapshot = useCallback(
    (request: RepositorySessionRequest, snapshot: RepositorySnapshot): boolean => {
      if (
        request.kind === 'history' ||
        request.kind === 'authors' ||
        !requests.isCurrent(request) ||
        repositorySessionKey(snapshot) !== request.path
      ) {
        return false
      }
      setUnavailableRepositoryPaths((current) => current.filter((path) => repositoryPathKey(path) !== request.path))
      const current = currentSnapshots.current
      const existing = current.find((item) => repositorySessionKey(item) === request.path)
      if (!existing && request.kind !== 'open') return false
      const sameAnchor = existing && sameHistoryContext(existing, snapshot)
      if (existing && !sameAnchor) requests.invalidateHistory(request.path)
      const preserveHistory = existing && request.kind === 'snapshot' && requests.hasNewerHistory(request) && sameAnchor
      publishSnapshots(
        upsertRepositorySnapshot(current, preserveHistory ? { ...snapshot, revisions: existing.revisions } : snapshot)
      )
      return true
    },
    [publishSnapshots, requests]
  )
  const applyHistory = useCallback(
    (request: RepositorySessionRequest, revisions: Revision[]): boolean => {
      if (request.kind !== 'history' || !requests.isCurrent(request)) return false
      publishSnapshots(updateRepositoryHistory(currentSnapshots.current, request.path, revisions))
      requests.didApplyHistory(request)
      return true
    },
    [publishSnapshots, requests]
  )
  const applyAuthorNames = useCallback(
    (request: RepositorySessionRequest, names: ReadonlyMap<string, string>): boolean => {
      if (request.kind !== 'authors' || !requests.isCurrent(request)) return false
      const current = currentSnapshots.current
      const next = updateRepositoryAuthorNames(current, request.path, names)
      if (next !== current) publishSnapshots(next)
      return next !== current
    },
    [publishSnapshots, requests]
  )
  const isActiveRepository = useCallback((path: string) => activeSessionKey.current === repositoryPathKey(path), [])

  const reorderRepositoryTabs = useCallback(
    (sourceRepositoryId: string, targetRepositoryId: string) => {
      publishSnapshots(
        reorderItemsById(currentSnapshots.current, sourceRepositoryId, targetRepositoryId, repositorySessionKey)
      )
    },
    [publishSnapshots]
  )

  /** 原生偏好恢复完成后一次性替换整个会话，避免逐仓库追加产生中间选中态。 */
  const replaceRepositorySession = useCallback(
    (nextSnapshots: RepositorySnapshot[], unavailablePaths: string[]) => {
      requests.retain(nextSnapshots.map((snapshot) => snapshot.repository.path))
      if (!nextSnapshots.some((snapshot) => repositorySessionKey(snapshot) === activeSessionKey.current)) {
        activeSessionKey.current = ''
      }
      publishSnapshots(nextSnapshots)
      setUnavailableRepositoryPaths(unavailablePaths)
      // 批量关闭和恢复都可能让旧活动 ID 失效；先清空，调用方若有首选快照会通过
      // 统一激活入口同步对象选区。保留仍存在的 ID 可避免仅刷新快照时产生闪烁。
      setActiveRepositoryId((current) =>
        nextSnapshots.some((snapshot) => repositorySessionKey(snapshot) === current) ? current : ''
      )
    },
    [publishSnapshots, requests]
  )

  /**
   * 关闭项目标签并返回应被激活的后继快照。
   *
   * Hook 负责清空已关闭的活动 ID；调用方拿到后继快照后仍通过统一激活入口更新
   * 服务器浏览草稿等跨领域状态。
   */
  const removeRepositorySnapshot = useCallback(
    (repositoryId: string): RepositorySnapshot | null => {
      const remaining = currentSnapshots.current.filter((snapshot) => repositorySessionKey(snapshot) !== repositoryId)
      requests.close(repositoryId)
      publishSnapshots(remaining)
      if (repositoryId !== activeSessionKey.current) return null

      const next = remaining[0] ?? null
      activeSessionKey.current = next ? repositorySessionKey(next) : ''
      setActiveRepositoryId(activeSessionKey.current)
      if (!next) {
        setSelectedRevisionId('')
        setSelectedBranchId('')
        setSelectedTagId('')
      }
      return next
    },
    [publishSnapshots, requests]
  )

  return {
    snapshots,
    activeRepositoryId,
    selectedRevisionId,
    selectedBranchId,
    selectedTagId,
    unavailableRepositoryPaths,
    setSelectedRevisionId,
    setSelectedBranchId,
    setSelectedTagId,
    activateRepositorySnapshot,
    upsertSnapshot,
    requests,
    applySnapshot,
    applyHistory,
    applyAuthorNames,
    isActiveRepository,
    reorderRepositoryTabs,
    replaceRepositorySession,
    removeRepositorySnapshot
  }
}
