import { useCallback, useEffect, useState } from 'react'

import type { InspectorTab, NavigationView } from '../types'
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

  const handleSearchResult = useCallback(
    (result: SearchResult) => {
      const target = resolveSearchNavigation(result)
      setActiveView(target.view)
      if (target.revisionId) onRevisionSelect(target.revisionId)
      if (target.branchId) onBranchSelect(target.branchId)
      if (target.inspectorTab) setInspectorTab(target.inspectorTab)
    },
    [onBranchSelect, onRevisionSelect, setInspectorTab]
  )

  return {
    activeView,
    setActiveView,
    inspectorTab,
    setInspectorTab,
    handleSearchResult
  }
}
