import { ArrowRight, CheckCircle2, GitBranch, Plus, Radio, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { sortBranchesByEnglishName } from '../../../shared/lib'
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
export interface OverviewBranchGroups {
  localBranches: Branch[]
  remoteBranches: Branch[]
}

/**
 * 先按 Lore 对象语义拆成本地与远程两组，再使用共享路径规则逐级排序。
 * 这里保留原始 DTO 引用，卡片选择、双击检出与右键菜单不会因展示分组而丢失上下文。
 */
export function groupOverviewBranches(branches: Branch[]): OverviewBranchGroups {
  const activeBranches = branches.filter((branch) => !branch.archived)
  return {
    localBranches: sortBranchesByEnglishName(activeBranches.filter((branch) => !branch.remote)),
    remoteBranches: sortBranchesByEnglishName(activeBranches.filter((branch) => branch.remote))
  }
}

export function activeOverviewBranches(branches: Branch[]): Branch[] {
  const { localBranches, remoteBranches } = groupOverviewBranches(branches)
  return [...localBranches, ...remoteBranches]
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
  const { t } = useTranslation()
  const { localBranches, remoteBranches } = groupOverviewBranches(branches)
  const visibleBranches = [...localBranches, ...remoteBranches]
  const current = visibleBranches.find((branch) => branch.current) ?? visibleBranches[0]

  /**
   * 两栏复用同一张分支卡片，避免本地与远程动作或可访问语义在后续演进中分叉。
   * 卡片始终从当前 DTO 读取修订号；排序改变时不会再出现数组下标造成的修订错配。
   */
  const renderBranchCard = (branch: Branch) => (
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
        <code>{branch.latest?.slice(0, 8) || t('noRevisions')}</code>
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
  )

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

      <div className="branch-overview__columns">
        <section className="branch-overview__column branch-overview__column--local" aria-label={t('localBranches')}>
          <header className="branch-overview__column-header">
            <GitBranch size={14} aria-hidden="true" />
            <strong>{t('localBranches')}</strong>
            <small>{t('status.visiblePointerCount', { count: localBranches.length })}</small>
          </header>
          <div className="branch-overview__column-list">{localBranches.map(renderBranchCard)}</div>
          {!localBranches.length && <p className="branch-overview__column-empty">{t('noLocalBranches')}</p>}
        </section>

        <section className="branch-overview__column branch-overview__column--remote" aria-label={t('remoteBranches')}>
          <header className="branch-overview__column-header">
            <Radio size={14} aria-hidden="true" />
            <strong>{t('remoteBranches')}</strong>
            <small>{t('status.visiblePointerCount', { count: remoteBranches.length })}</small>
          </header>
          <div className="branch-overview__column-list">{remoteBranches.map(renderBranchCard)}</div>
          {!remoteBranches.length && <p className="branch-overview__column-empty">{t('noRemoteBranches')}</p>}
        </section>
      </div>
    </section>
  )
}
