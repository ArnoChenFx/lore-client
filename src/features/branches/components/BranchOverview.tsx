import { ArrowRight, CheckCircle2, GitBranch, Plus, Radio, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { t } from '../../../i18n'
import type { ContextMenuPoint } from '../../../shared/ui'
import type { Branch } from '../../../types'

interface BranchOverviewProps {
  branches: Branch[]
  demoMode: boolean
  selectedBranchId: string
  onSelect: (branch: Branch) => void
  onCheckout: (branch: Branch) => void
  onContextMenu: (branch: Branch, point: ContextMenuPoint) => void
  onCreate: () => void
}

/**
 * 分支总览只展示可检出的活动本地/远端指针。
 *
 * 已归档分支由侧栏独立分组承接；混入总览会让双击检出与活动分支菜单语义落到
 * 只读归档项上，因此这里与 `groupSidebarBranches` 共用同一排除条件。
 */
export function activeOverviewBranches(branches: Branch[]): Branch[] {
  return branches.filter((branch) => !branch.archived)
}

export function BranchOverview({
  branches,
  demoMode,
  selectedBranchId,
  onSelect,
  onCheckout,
  onContextMenu,
  onCreate
}: BranchOverviewProps) {
  const visibleBranches = activeOverviewBranches(branches)
  const current = visibleBranches.find((branch) => branch.current) ?? visibleBranches[0]

  if (!current) {
    return (
      <section className="branch-overview">
        <div className="empty-state">
          <GitBranch size={24} />
          <strong>{t('thisRepositoryHasNoBranches')}</strong>
          <span>{t('createFirstRevisionStartManaging_0f7d')}</span>
        </div>
      </section>
    )
  }

  return (
    <section className="branch-overview">
      <header className="branch-overview__header">
        <div>
          <span className="panel-header__eyebrow">{t('branchPointer')}</span>
          <strong>{t('branchOverview')}</strong>
          <small>{t('status.visiblePointerCount', { count: visibleBranches.length })}</small>
        </div>
        <button type="button" onClick={onCreate}>
          <Plus size={14} />
          {t('newBranch')}
        </button>
      </header>

      <article className="current-branch-card">
        <span className="current-branch-card__icon">
          <GitBranch size={21} />
        </span>
        <div>
          <small>{t('current')}</small>
          <h2>{current.name}</h2>
          <p>
            {demoMode
              ? t('pointsRevisionC7f3a81d2Revisions_78dd')
              : t('status.pointsToRevision', {
                  id: current.latest?.slice(0, 8) || t('noRecordYet')
                })}
          </p>
        </div>
        <span className="branch-state">
          <CheckCircle2 size={13} />
          {t('workspaceAttached')}
        </span>
      </article>

      <div className="branch-grid">
        {visibleBranches.map((branch, index) => (
          <button
            key={branch.id}
            type="button"
            className={`branch-card ${branch.remote ? 'is-remote' : ''} ${branch.current ? 'is-current' : ''} ${branch.id === selectedBranchId ? 'is-selected' : ''}`}
            onClick={() => onSelect(branch)}
            onDoubleClick={() => onCheckout(branch)}
            onContextMenu={(event) => {
              event.preventDefault()
              onContextMenu(branch, {
                x: event.clientX,
                y: event.clientY,
                anchor: event.currentTarget
              })
            }}
            title={t('status.selectDoubleClickCheckout', { name: branch.name })}
          >
            <span className="branch-card__rail" />
            <span className="branch-card__top">
              {branch.remote ? <Radio size={14} /> : <GitBranch size={14} />}
              <small>{branch.remote ? t('remote') : t('local')}</small>
              {branch.current && <em>{t('current')}</em>}
            </span>
            <strong>{branch.name}</strong>
            <span className="branch-card__revision">
              <code>
                {demoMode
                  ? ['c7f3a81d', '5de935ea', '1dd6e2a3', '0a9d82f3'][index % 4]
                  : branch.latest?.slice(0, 8) || t('noRevisions')}
              </code>
              <span>{branch.author ?? (demoMode ? 'lore-eu-01' : t('unknownCreator'))}</span>
            </span>
            <span className="branch-card__footer">
              {branch.ahead ? (
                <b>{t('status.aheadBy', { value: branch.ahead })}</b>
              ) : (
                <span>
                  <ShieldCheck size={12} />
                  {t('synced')}
                </span>
              )}
              <ArrowRight size={14} />
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}
