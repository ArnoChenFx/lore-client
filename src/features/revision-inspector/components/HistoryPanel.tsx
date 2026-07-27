import { AlignJustify, Columns3, Filter, GitGraph, GitMerge, ListFilter, LoaderCircle, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useClientPreferences } from '../../../hooks/useClientPreferences'
import { useDismissiblePopover } from '../../../hooks/useDismissiblePopover'
import { t } from '../../../i18n'
import { shouldDisplayRevisionAuthorEmail } from '../../../shared/lib'
import {
  CheckboxInput,
  ControlInput,
  NumberInput,
  RevisionAuthorAvatar,
  SelectInput,
  TextButton,
  TextInput,
  type ContextMenuPoint
} from '../../../shared/ui'
import type { Branch, LoreTag, Repository, Revision, RevisionHistoryQuery } from '../../../types'
import { filterRevisions } from '../revisionFilter'
import { branchPointersForLaneMode, revisionIdsAheadOfHead, revisionsForLaneMode } from '../revisionHistoryMode'
import { RevisionGraph } from './RevisionGraph'
import { calculateFlatRevisionGraphLayout, calculateRevisionGraphLayout } from './revisionGraphLayout'

interface HistoryPanelProps {
  repository: Repository
  revisions: Revision[]
  tags: LoreTag[]
  branches: Branch[]
  historyQuery: RevisionHistoryQuery
  historyLoading: boolean
  selectedId: string
  onSelect: (revision: Revision) => void
  onCheckout: (revision: Revision) => void
  onContextMenu: (revision: Revision, point: ContextMenuPoint) => void
  onTagSelect: (tag: LoreTag) => void
  onTagContextMenu: (tag: LoreTag, point: ContextMenuPoint) => void
  onHistoryQuery: (query: RevisionHistoryQuery) => void
}

/** Revision 徽标使用原生 title 提示，避免 hover 时引入会遮挡密集历史行的浮层状态。 */
export function revisionTagTooltip(tag: LoreTag): string {
  const message = tag.message.trim() || t('noTagDescription')
  return [
    tag.name,
    t('status.tagDescription', { message }),
    t('status.tagSourceBranch', { branch: tag.branch }),
    t('status.tagTargetRevision', { revision: tag.revision.slice(0, 8) }),
    t('clickSelectTagRightClick_5323')
  ].join('\n')
}

export function HistoryPanel({
  repository,
  revisions,
  tags,
  branches,
  historyQuery,
  historyLoading,
  selectedId,
  onSelect,
  onCheckout,
  onContextMenu,
  onTagSelect,
  onTagContextMenu,
  onHistoryQuery
}: HistoryPanelProps) {
  const [query, setQuery] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [mergesOnly, setMergesOnly] = useState(false)
  const [showAuthor, setShowAuthor] = useState(true)
  const [showTime, setShowTime] = useState(true)
  const historyOptionsRef = useDismissiblePopover<HTMLDivElement>(filterOpen || columnsOpen, () => {
    setFilterOpen(false)
    setColumnsOpen(false)
  })
  const { preferences, update: updatePreferences } = useClientPreferences()
  const [historyRevision, setHistoryRevision] = useState(historyQuery.revision ?? '')
  const [historyBranch, setHistoryBranch] = useState(historyQuery.branch ?? '')
  const [historyBeforeDate, setHistoryBeforeDate] = useState(() =>
    historyQuery.beforeDate ? new Date(historyQuery.beforeDate * 1_000).toISOString().slice(0, 10) : ''
  )
  const [historyOnlyBranch, setHistoryOnlyBranch] = useState(historyQuery.onlyBranch)
  const [historyLimit, setHistoryLimit] = useState(historyQuery.limit)

  useEffect(() => {
    setHistoryRevision(historyQuery.revision ?? '')
    setHistoryBranch(historyQuery.branch ?? '')
    setHistoryBeforeDate(
      historyQuery.beforeDate ? new Date(historyQuery.beforeDate * 1_000).toISOString().slice(0, 10) : ''
    )
    setHistoryOnlyBranch(historyQuery.onlyBranch)
    setHistoryLimit(historyQuery.limit)
  }, [historyQuery])

  const laneModeRevisions = useMemo(
    () => revisionsForLaneMode(revisions, repository, branches, preferences.revisionHistoryLaneMode),
    [branches, preferences.revisionHistoryLaneMode, repository, revisions]
  )
  /*
   * 相对 HEAD 状态基于搜索前的完整 Lane 投影计算。若在 filteredRevisions
   * 上寻找 HEAD，用户输入筛选词隐藏 HEAD 后，较新行会错误地丢失背景。
   */
  const revisionsAheadOfHead = useMemo(
    () => revisionIdsAheadOfHead(laneModeRevisions, repository.revision),
    [laneModeRevisions, repository.revision]
  )
  const filteredRevisions = useMemo(
    () => filterRevisions(laneModeRevisions, query).filter((revision) => !mergesOnly || revision.parentCount > 1),
    [laneModeRevisions, mergesOnly, query]
  )
  /*
   * 底部统计与分页条移除后，过滤结果直接交给列表自身的滚动区完整呈现。
   * 图谱必须在最终结果上一次性计算。逐行把 `track` 传给 SVG 无法
   * 知道相邻行仍有哪些活跃 lane，也就无法正确表达跨行分叉与汇合。
   */
  const revisionGraphLayout = useMemo(
    () =>
      preferences.revisionHistoryLaneMode === 'flat'
        ? calculateFlatRevisionGraphLayout(filteredRevisions)
        : calculateRevisionGraphLayout(filteredRevisions),
    [filteredRevisions, preferences.revisionHistoryLaneMode]
  )

  return (
    <section className="history-panel" aria-label={t('revisionHistory')}>
      <header className="panel-header">
        <div className="panel-header__title">
          <span className="panel-header__eyebrow">{t('currentBranch')}</span>
          <strong>{repository.branch}</strong>
          <span className="branch-delta">
            ↑{repository.ahead} ↓{repository.behind}
          </span>
        </div>
        <div className="panel-header__tools">
          <label className="inline-search composite-input">
            <Search size={13} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('filterRevisions')}
              aria-label={t('filterRevisions')}
            />
          </label>
          <div className="history-options-control" ref={historyOptionsRef}>
            <button
              type="button"
              className={
                filterOpen ||
                mergesOnly ||
                historyQuery.revision ||
                historyQuery.branch ||
                historyQuery.beforeDate ||
                historyQuery.onlyBranch
                  ? 'is-active'
                  : ''
              }
              aria-label={t('filterOptions')}
              aria-expanded={filterOpen}
              title={t('filterOptions')}
              onClick={() => {
                setFilterOpen((value) => !value)
                setColumnsOpen(false)
              }}
            >
              <ListFilter size={15} />
            </button>
            <button
              type="button"
              className={columnsOpen || !showAuthor || !showTime ? 'is-active' : ''}
              aria-label={t('historyDisplayOptions')}
              aria-expanded={columnsOpen}
              title={t('historyDisplayOptions')}
              onClick={() => {
                setColumnsOpen((value) => !value)
                setFilterOpen(false)
              }}
            >
              <Columns3 size={15} />
            </button>
            {(filterOpen || columnsOpen) && (
              <div className="history-options">
                {filterOpen ? (
                  <>
                    <div className="tool-popover__heading">
                      <ListFilter size={13} />
                      <strong>{t('filterOptions')}</strong>
                    </div>
                    <div className="history-options__checks">
                      <label className="tool-check">
                        <CheckboxInput checked={mergesOnly} onChange={(event) => setMergesOnly(event.target.checked)} />
                        <span>{t('mergeRevisionsOnly')}</span>
                      </label>
                    </div>
                    <span className="tool-popover__divider" />
                    <div className="history-options__fields">
                      <label className="tool-field tool-field--horizontal">
                        <span>{t('historyStartingRevision')}</span>
                        <TextInput
                          value={historyRevision}
                          spellCheck={false}
                          placeholder={t('revisionId')}
                          title={t('historyStartingRevisionPlaceholder')}
                          onChange={(event) => setHistoryRevision(event.target.value)}
                        />
                      </label>
                      <label className="tool-field tool-field--horizontal">
                        <span>{t('historyBranch')}</span>
                        <SelectInput
                          chevronSize={12}
                          value={historyBranch}
                          onChange={(event) => setHistoryBranch(event.target.value)}
                        >
                          <option value="">{t('currentBranch')}</option>
                          {branches
                            .filter((branch) => !branch.remote && !branch.archived)
                            .map((branch) => (
                              <option key={branch.id} value={branch.name}>
                                {branch.name}
                              </option>
                            ))}
                        </SelectInput>
                      </label>
                      <label className="tool-field tool-field--horizontal">
                        <span>{t('historyBeforeDate')}</span>
                        <ControlInput
                          type="date"
                          value={historyBeforeDate}
                          onChange={(event) => setHistoryBeforeDate(event.target.value)}
                        />
                      </label>
                      <label className="tool-field tool-field--horizontal">
                        <span>{t('historyLimit')}</span>
                        <NumberInput
                          min={1}
                          max={1000}
                          value={historyLimit}
                          onChange={(event) =>
                            setHistoryLimit(Math.max(1, Math.min(1000, Number(event.target.value) || 100)))
                          }
                        />
                      </label>
                    </div>
                    <label className="tool-check history-options__branch-check">
                      <CheckboxInput
                        checked={historyOnlyBranch}
                        onChange={(event) => setHistoryOnlyBranch(event.target.checked)}
                      />
                      <span>{t('historyOnlySelectedBranch')}</span>
                    </label>
                    <footer className="history-options__footer">
                      <TextButton
                        variant="primary"
                        className="history-options__apply"
                        disabled={historyLoading}
                        onClick={() =>
                          onHistoryQuery({
                            revision: historyRevision.trim() || undefined,
                            branch: historyBranch || undefined,
                            beforeDate: historyBeforeDate
                              ? Math.floor(new Date(`${historyBeforeDate}T23:59:59`).getTime() / 1_000)
                              : undefined,
                            onlyBranch: historyOnlyBranch,
                            limit: historyLimit
                          })
                        }
                      >
                        {historyLoading && <LoaderCircle className="is-spinning" size={13} />}
                        {t('applyHistoryFilter')}
                      </TextButton>
                    </footer>
                  </>
                ) : (
                  <>
                    <div className="tool-popover__heading">
                      <Columns3 size={13} />
                      <strong>{t('visibleColumns')}</strong>
                    </div>
                    <div className="history-options__checks">
                      <label className="tool-check">
                        <CheckboxInput checked={showAuthor} onChange={(event) => setShowAuthor(event.target.checked)} />
                        <span>{t('showAuthor')}</span>
                      </label>
                      <label className="tool-check">
                        <CheckboxInput checked={showTime} onChange={(event) => setShowTime(event.target.checked)} />
                        <span>{t('showTime')}</span>
                      </label>
                    </div>
                    <span className="tool-popover__divider" />
                    <div className="tool-popover__heading" id="revision-lane-presentation-label">
                      <GitGraph size={13} />
                      <strong>{t('revisionLanePresentation')}</strong>
                    </div>
                    <div
                      className="history-options__lane-modes"
                      role="radiogroup"
                      aria-labelledby="revision-lane-presentation-label"
                    >
                      <label className="history-lane-option">
                        <input
                          type="radio"
                          name="revision-lane-mode"
                          value="topology"
                          checked={preferences.revisionHistoryLaneMode === 'topology'}
                          onChange={() => updatePreferences({ revisionHistoryLaneMode: 'topology' })}
                        />
                        <GitGraph aria-hidden="true" size={14} />
                        <span>
                          <strong>{t('revisionLaneTopology')}</strong>
                          <small>{t('revisionLaneTopologyDescription')}</small>
                        </span>
                      </label>
                      <label className="history-lane-option">
                        <input
                          type="radio"
                          name="revision-lane-mode"
                          value="flat"
                          checked={preferences.revisionHistoryLaneMode === 'flat'}
                          onChange={() => updatePreferences({ revisionHistoryLaneMode: 'flat' })}
                        />
                        <AlignJustify aria-hidden="true" size={14} />
                        <span>
                          <strong>{t('revisionLaneFlat')}</strong>
                          <small>{t('revisionLaneFlatDescription')}</small>
                        </span>
                      </label>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      <div
        className={`history-columns ${!showAuthor ? 'hide-author' : ''} ${!showTime ? 'hide-time' : ''}`}
        aria-hidden="true"
      >
        <span>{t('revisions')}</span>
        <span>{t('author')}</span>
        <span>{t('time')}</span>
      </div>

      <div className="history-list" data-lane-mode={preferences.revisionHistoryLaneMode}>
        {filteredRevisions.length === 0 ? (
          <div className="empty-state">
            <Filter size={22} />
            <strong>{t('noMatchingRevisions')}</strong>
            <span>{t('trySearchingTitleAuthorHash_a3ab')}</span>
          </div>
        ) : (
          filteredRevisions.map((revision, revisionIndex) => {
            const selected = revision.id === selectedId
            const attachedTags = tags.filter((tag) => tag.revision === revision.id)
            const visibleBranchPointers = branchPointersForLaneMode(
              revision.branchPointers,
              repository,
              branches,
              preferences.revisionHistoryLaneMode
            )
            return (
              <div
                key={revision.id}
                role="button"
                tabIndex={0}
                className={`revision-row ${revisionsAheadOfHead.has(revision.id) ? 'is-ahead-of-head' : ''} ${selected ? 'is-selected' : ''} ${!showAuthor ? 'hide-author' : ''} ${!showTime ? 'hide-time' : ''}`}
                onClick={() => onSelect(revision)}
                onDoubleClick={() => onCheckout(revision)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onSelect(revision)
                  }
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  onContextMenu(revision, {
                    x: event.clientX,
                    y: event.clientY,
                    anchor: event.currentTarget
                  })
                }}
                title={t('clickSelectRevisionDoubleClick_03c5')}
              >
                <RevisionGraph
                  layout={revisionGraphLayout.rows[revisionIndex]}
                  laneCount={revisionGraphLayout.laneCount}
                  selected={selected}
                />
                <span className="revision-row__content">
                  <span className="revision-row__title">
                    {revision.parentCount > 1 && <GitMerge size={12} />}
                    <strong>{revision.title}</strong>
                  </span>
                  <span className="revision-row__meta">
                    <code>{revision.shortId}</code>
                    {visibleBranchPointers.map((pointer) => {
                      return (
                        <em key={pointer.id} className={pointer.kind === 'local' ? undefined : `is-${pointer.kind}`}>
                          {pointer.name}
                        </em>
                      )
                    })}
                    {attachedTags.map((tag) => (
                      <button
                        key={tag.id}
                        type="button"
                        className="revision-row__tag"
                        title={revisionTagTooltip(tag)}
                        onClick={(event) => {
                          event.stopPropagation()
                          onTagSelect(tag)
                        }}
                        onDoubleClick={(event) => event.stopPropagation()}
                        onContextMenu={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          onTagContextMenu(tag, {
                            x: event.clientX,
                            y: event.clientY,
                            anchor: event.currentTarget
                          })
                        }}
                      >
                        {tag.name}
                      </button>
                    ))}
                  </span>
                </span>
                <span className="revision-row__author">
                  <RevisionAuthorAvatar
                    identity={revision.authorEmail ?? revision.author}
                    initials={revision.initials}
                    variant="compact"
                  />
                  <span className="revision-row__author-copy">
                    <strong title={revision.author}>{revision.author}</strong>
                    {/*
                     * 历史身份的邮箱只在该 Revision 自身明确携带时展示，绝不能用
                     * 当前仓库身份补齐旧历史。列表列宽有限，因此视觉上允许省略，
                     * 但 title 始终保留完整邮箱供鼠标用户核对。
                     */}
                    {shouldDisplayRevisionAuthorEmail(revision.author, revision.authorEmail) && (
                      <small title={revision.authorEmail}>{revision.authorEmail}</small>
                    )}
                  </span>
                </span>
                <time dateTime={revision.timestamp}>
                  {revision.relativeTime}
                  <small>{revision.timestamp.slice(5, 16)}</small>
                </time>
              </div>
            )
          })
        )}
      </div>
    </section>
  )
}
