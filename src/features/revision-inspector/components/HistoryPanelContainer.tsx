import { useCallback, useEffect, useRef, useState } from 'react'

import { useAdjustFromProps } from '../../../hooks/useAdjustFromProps'
import { useClientPreferences } from '../../../hooks/useClientPreferences'
import { t } from '../../../i18n'
import { loadRevisionHistory } from '../../../services/lore'
import { readErrorMessage } from '../../../shared/lib'
import type { ContextMenuPoint } from '../../../shared/ui'
import type {
  ApplicationMode,
  LoreTag,
  RepositorySnapshot,
  Revision,
  RevisionHistoryQuery,
  RevisionRevealRequest
} from '../../../types'
import type { AppNotify } from '../../repository-session'
import { revisionHistoryQueryForLaneMode } from '../revisionHistoryMode'
import { HistoryPanel } from './HistoryPanel'

interface HistoryPanelContainerProps {
  applicationMode: ApplicationMode
  snapshot: RepositorySnapshot
  selectedId: string
  revealRequest: RevisionRevealRequest | null
  onSelectedIdChange: (revisionId: string) => void
  onSnapshotChange: (snapshot: RepositorySnapshot) => void
  onCheckout: (revision: Revision) => void
  onContextMenu: (revision: Revision, point: ContextMenuPoint) => void
  onTagSelect: (tag: LoreTag) => void
  onTagContextMenu: (tag: LoreTag, point: ContextMenuPoint) => void
  notify: AppNotify
}

const DEFAULT_HISTORY_QUERY: RevisionHistoryQuery = {
  onlyBranch: false,
  limit: 100
}

/**
 * Revision History 的查询容器。
 *
 * 查询草稿、加载状态和 Lane 模式切换只影响历史列表，因此与历史面板共同下沉；
 * App 只保留跨面板共享的精确 Revision 选中态。
 */
export function HistoryPanelContainer({
  applicationMode,
  snapshot,
  selectedId,
  revealRequest,
  onSelectedIdChange,
  onSnapshotChange,
  onCheckout,
  onContextMenu,
  onTagSelect,
  onTagContextMenu,
  notify
}: HistoryPanelContainerProps) {
  const { preferences, ready: preferencesReady } = useClientPreferences()
  const [historyQuery, setHistoryQuery] = useState<RevisionHistoryQuery>(DEFAULT_HISTORY_QUERY)
  const [historyLoading, setHistoryLoading] = useState(false)
  const previousLaneMode = useRef(preferences.revisionHistoryLaneMode)

  /** 只重读历史列表，保留工作区状态、Inspector 标签和其他仓库会话。 */
  const applyHistoryQuery = useCallback(
    async (query: RevisionHistoryQuery) => {
      if (applicationMode !== 'tauri') {
        setHistoryQuery(query)
        return
      }
      const effectiveQuery = revisionHistoryQueryForLaneMode(
        query,
        snapshot.repository,
        preferences.revisionHistoryLaneMode
      )
      try {
        setHistoryLoading(true)
        const revisions = await loadRevisionHistory(snapshot.repository, snapshot.branches, effectiveQuery)
        onSnapshotChange({
          ...snapshot,
          revisions,
          loadedAt: new Date().toISOString()
        })
        setHistoryQuery(query)
        if (!revisions.some((revision) => revision.id === selectedId)) {
          onSelectedIdChange(revisions[0]?.id ?? '')
        }
      } catch (error) {
        notify(t('unableToLoadRevisionHistory'), readErrorMessage(error), 'warning')
      } finally {
        setHistoryLoading(false)
      }
    },
    [
      applicationMode,
      notify,
      onSelectedIdChange,
      onSnapshotChange,
      preferences.revisionHistoryLaneMode,
      selectedId,
      snapshot
    ]
  )

  useEffect(() => {
    const currentMode = preferences.revisionHistoryLaneMode
    if (!preferencesReady || previousLaneMode.current === currentMode) return
    previousLaneMode.current = currentMode
    /*
     * Lane 模式会改变历史数据边界，必须立即从 Lore 重读；仅修改前端投影会让
     * 平铺和拓扑模式消费错误的 Revision 集合。
     */
    void applyHistoryQuery(historyQuery)
  }, [applyHistoryQuery, historyQuery, preferences.revisionHistoryLaneMode, preferencesReady])

  // 查询只属于当前仓库；切换项目时回到完整的当前 Branch 历史。渲染期跟随
  // （官方 adjusting state during render 模式，useAdjustFromProps），避免 effect
  // 同步 setState（react-compiler EffectSetState）。
  useAdjustFromProps(snapshot.repository.path, () => {
    setHistoryQuery(DEFAULT_HISTORY_QUERY)
    setHistoryLoading(false)
  })

  return (
    <HistoryPanel
      repository={snapshot.repository}
      revisions={snapshot.revisions}
      tags={snapshot.tags}
      branches={snapshot.branches}
      historyQuery={historyQuery}
      historyLoading={historyLoading}
      selectedId={selectedId}
      revealRequest={revealRequest}
      onSelect={(revision) => onSelectedIdChange(revision.id)}
      onCheckout={onCheckout}
      onContextMenu={onContextMenu}
      onTagSelect={onTagSelect}
      onTagContextMenu={onTagContextMenu}
      onHistoryQuery={(query) => void applyHistoryQuery(query)}
    />
  )
}
