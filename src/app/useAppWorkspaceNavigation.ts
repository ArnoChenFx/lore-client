import { useCallback, useEffect, useState } from 'react'

import type { InspectorTab, NavigationView, RevisionRevealRequest } from '../types'
import type { SearchResult } from './components/SearchDialog'

interface UseAppWorkspaceNavigationOptions {
  preferredInspectorTab: InspectorTab
  preferencesReady: boolean
  onInspectorTabPreferenceChange: (tab: InspectorTab) => void
  onRevisionSelect: (revisionId: string) => void
  onBranchSelect: (branchId: string) => void
}

export interface SearchNavigationTarget {
  view: NavigationView
  inspectorTab?: InspectorTab
  revisionId?: string
  branchId?: string
}

/** 为重复定位同一 Revision 生成可观察的新请求。 */
export function nextRevisionRevealRequest(
  previous: RevisionRevealRequest | null,
  revisionId: string
): RevisionRevealRequest {
  return {
    revisionId,
    sequence: (previous?.sequence ?? 0) + 1
  }
}

/** 把搜索结果转换为不含副作用的联合导航目标，便于独立验证跨面板定位语义。 */
export function resolveSearchNavigation(result: SearchResult): SearchNavigationTarget {
  if (result.kind === 'revision') {
    return { view: 'history', revisionId: result.value.id }
  }
  if (result.kind === 'branch') {
    return { view: 'branches', branchId: result.value.id }
  }
  return { view: 'changes', inspectorTab: 'changes' }
}

/**
 * 管理一级工作区与 Inspector 标签的联合导航。
 *
 * 搜索结果可能同时改变一级视图和 Inspector 标签，因此两者由同一控制器原子协调；
 * 仓库对象的精确选中态仍留在 Repository Session，不在这里复制。
 */
export function useAppWorkspaceNavigation({
  preferredInspectorTab,
  preferencesReady,
  onInspectorTabPreferenceChange,
  onRevisionSelect,
  onBranchSelect
}: UseAppWorkspaceNavigationOptions) {
  const [activeView, setActiveView] = useState<NavigationView>('history')
  const [inspectorTab, setInspectorTabState] = useState<InspectorTab>(preferredInspectorTab)
  const [revisionRevealRequest, setRevisionRevealRequest] = useState<RevisionRevealRequest | null>(null)

  const setInspectorTab = useCallback(
    (tab: InspectorTab) => {
      setInspectorTabState(tab)
      onInspectorTabPreferenceChange(tab)
    },
    [onInspectorTabPreferenceChange]
  )

  useEffect(() => {
    if (!preferencesReady) return
    setInspectorTabState(preferredInspectorTab)
  }, [preferencesReady, preferredInspectorTab])

  const revealRevision = useCallback(
    (revisionId: string) => {
      /*
       * 视图、选中态与滚动事件必须来自同一入口。请求带递增序号，因此历史面板已
       * 选中该 Revision 时，用户再次点击来源对象仍能重新定位，而不会被状态去重。
       */
      setActiveView('history')
      onRevisionSelect(revisionId)
      setRevisionRevealRequest((previous) => nextRevisionRevealRequest(previous, revisionId))
    },
    [onRevisionSelect]
  )

  const handleSearchResult = useCallback(
    (result: SearchResult) => {
      const target = resolveSearchNavigation(result)
      if (target.revisionId) revealRevision(target.revisionId)
      else setActiveView(target.view)
      if (target.branchId) onBranchSelect(target.branchId)
      if (target.inspectorTab) setInspectorTab(target.inspectorTab)
    },
    [onBranchSelect, revealRevision, setInspectorTab]
  )

  return {
    activeView,
    setActiveView,
    inspectorTab,
    setInspectorTab,
    revisionRevealRequest,
    revealRevision,
    handleSearchResult
  }
}
