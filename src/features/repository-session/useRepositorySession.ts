import { useCallback, useState } from 'react'

import type { RepositorySnapshot } from '../../types'
import { reorderItemsById } from './components/repositoryTabsModel'

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
 * 工作区状态和窗口 Tab。路径按当前项目既有的 Windows 大小写不敏感规则规范化。
 */
export function repositorySessionKey(snapshot: RepositorySnapshot): string {
  return snapshot.repository.path.trim().toLocaleLowerCase('en-US')
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

  const activateRepositorySnapshot = useCallback((snapshot: RepositorySnapshot) => {
    const selection = repositorySelection(snapshot)
    setActiveRepositoryId(repositorySessionKey(snapshot))
    setSelectedRevisionId(selection.revisionId)
    setSelectedBranchId(selection.branchId)
    setSelectedTagId(selection.tagId)
  }, [])

  const upsertSnapshot = useCallback((nextSnapshot: RepositorySnapshot) => {
    setUnavailableRepositoryPaths((current) =>
      current.filter((path) => path.toLocaleLowerCase() !== nextSnapshot.repository.path.toLocaleLowerCase())
    )
    setSnapshots((current) => upsertRepositorySnapshot(current, nextSnapshot))
  }, [])

  const reorderRepositoryTabs = useCallback((sourceRepositoryId: string, targetRepositoryId: string) => {
    setSnapshots((current) => reorderItemsById(current, sourceRepositoryId, targetRepositoryId, repositorySessionKey))
  }, [])

  /** 原生偏好恢复完成后一次性替换整个会话，避免逐仓库追加产生中间选中态。 */
  const replaceRepositorySession = useCallback((nextSnapshots: RepositorySnapshot[], unavailablePaths: string[]) => {
    setSnapshots(nextSnapshots)
    setUnavailableRepositoryPaths(unavailablePaths)
    // 批量关闭和恢复都可能让旧活动 ID 失效；先清空，调用方若有首选快照会通过
    // 统一激活入口同步对象选区。保留仍存在的 ID 可避免仅刷新快照时产生闪烁。
    setActiveRepositoryId((current) =>
      nextSnapshots.some((snapshot) => repositorySessionKey(snapshot) === current) ? current : ''
    )
  }, [])

  /**
   * 关闭项目标签并返回应被激活的后继快照。
   *
   * Hook 负责清空已关闭的活动 ID；调用方拿到后继快照后仍通过统一激活入口更新
   * 服务器浏览草稿等跨领域状态。
   */
  const removeRepositorySnapshot = useCallback(
    (repositoryId: string): RepositorySnapshot | null => {
      const remaining = snapshots.filter((snapshot) => repositorySessionKey(snapshot) !== repositoryId)
      setSnapshots(remaining)
      if (repositoryId !== activeRepositoryId) return null

      const next = remaining[0] ?? null
      if (!next) setActiveRepositoryId('')
      return next
    },
    [activeRepositoryId, snapshots]
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
    reorderRepositoryTabs,
    replaceRepositorySession,
    removeRepositorySnapshot
  }
}
