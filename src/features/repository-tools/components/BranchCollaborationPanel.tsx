import { GitCompareArrows, History, LoaderCircle, RefreshCw, ShieldCheck, ShieldOff, Undo2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { SelectInput } from '../../../shared/ui'
import type { Branch, LoreBranchDiff, LoreBranchInfo, LoreBranchLatestEntry } from '../../../types'

interface BranchCollaborationPanelProps {
  repositoryRevision: string
  branches: Branch[]
  disabled: boolean
  onLoadBranch: (branch: string) => Promise<{ info: LoreBranchInfo; latest: LoreBranchLatestEntry[] }>
  onLoadDiff: (source: string, target: string, path?: string) => Promise<LoreBranchDiff>
  onSetProtected: (branch: string, protectedValue: boolean) => Promise<boolean>
  onReset: (
    branch: string,
    revision: string,
    expectedWorkspaceRevision: string,
    expectedLatest: string,
    skippedEntries: number
  ) => Promise<boolean>
}

interface BranchDiffResultProps {
  diff: LoreBranchDiff
}

/**
 * 把 Lore 的开放字符串动作收敛为少量视觉语义。
 *
 * 上游 0.x 仍可能增加新的动作值，因此 DOM 会继续显示原始值；这里只决定徽标颜色，
 * 未知动作安全降级为中性样式，不能因为前端枚举不完整而隐藏比较结果。
 */
function branchDiffActionTone(action: string) {
  switch (action.toLowerCase()) {
    case 'add':
    case 'copy':
      return 'is-positive'
    case 'delete':
    case 'remove':
      return 'is-negative'
    default:
      return 'is-neutral'
  }
}

/**
 * Branch Diff 使用专用的固定列位，不复用带图标列和操作列的通用资源列表。
 * 文件路径始终占据弹性主列，动作与自动合并状态则停靠在行尾，长路径只在自身列内省略。
 */
export function BranchDiffResult({ diff }: BranchDiffResultProps) {
  const { t } = useTranslation()

  return (
    <div className="branch-collaboration__diff">
      <section>
        <header>
          <strong>{t('branchChanges')}</strong>
          <small>{diff.changes.length}</small>
        </header>
        {diff.changes.length ? (
          <ul className="branch-diff-list">
            {diff.changes.map((change) => (
              <li key={change.path}>
                <strong className="branch-diff-list__path" title={change.path}>
                  {change.path}
                </strong>
                <span className="branch-diff-list__badges">
                  <code className={`branch-diff-action ${branchDiffActionTone(change.action)}`}>{change.action}</code>
                  {change.automerged && <small className="branch-diff-auto-merge">{t('autoMerged')}</small>}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p>{t('noBranchChanges')}</p>
        )}
      </section>
      <section>
        <header>
          <strong>{t('branchConflicts')}</strong>
          <small>{diff.conflicts.length}</small>
        </header>
        {diff.conflicts.length ? (
          <ul className="branch-diff-list branch-diff-list--conflicts">
            {diff.conflicts.map((conflict) => (
              <li key={conflict.path}>
                <strong className="branch-diff-list__path" title={conflict.path}>
                  {conflict.path}
                </strong>
                <span className="branch-diff-list__comparison">
                  <span>
                    <small>{t('sourceBranch')}</small>
                    <code className={`branch-diff-action ${branchDiffActionTone(conflict.source.action)}`}>
                      {conflict.source.action}
                    </code>
                  </span>
                  <span aria-hidden="true">→</span>
                  <span>
                    <small>{t('targetBranch')}</small>
                    <code className={`branch-diff-action ${branchDiffActionTone(conflict.target.action)}`}>
                      {conflict.target.action}
                    </code>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p>{t('noBranchConflicts')}</p>
        )}
      </section>
    </div>
  )
}

/**
 * Branch 协作页把只读审计、保护与破坏性 Reset 放在同一上下文中。
 *
 * 组件只允许选择真实本地活动分支；远端与归档对象继续遵循各自的只读语义。
 * Reset 目标只能来自 Lore 返回的 Latest 历史，不能手输任意 Revision。
 */
export function BranchCollaborationPanel({
  repositoryRevision,
  branches,
  disabled,
  onLoadBranch,
  onLoadDiff,
  onSetProtected,
  onReset
}: BranchCollaborationPanelProps) {
  const { t } = useTranslation()
  const localBranches = useMemo(() => branches.filter((branch) => !branch.remote && !branch.archived), [branches])
  const initialBranch = localBranches.find((branch) => branch.current)?.name ?? localBranches[0]?.name ?? ''
  const [selectedBranch, setSelectedBranch] = useState(initialBranch)
  const [info, setInfo] = useState<LoreBranchInfo | null>(null)
  const [latest, setLatest] = useState<LoreBranchLatestEntry[]>([])
  const [sourceBranch, setSourceBranch] = useState(initialBranch)
  const [targetBranch, setTargetBranch] = useState(
    localBranches.find((branch) => branch.name !== initialBranch)?.name ?? initialBranch
  )
  const [diffPath, setDiffPath] = useState('')
  const [diff, setDiff] = useState<LoreBranchDiff | null>(null)
  const [resetRevision, setResetRevision] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  const refreshBranch = async (branch: string) => {
    if (!branch) return
    setPending(true)
    setError('')
    try {
      const loaded = await onLoadBranch(branch)
      setInfo(loaded.info)
      setLatest(loaded.latest)
      /*
       * 第一条是当前 Latest，不提供无效果的 Reset；默认选择最近的历史指针，
       * 没有可回退记录时保持空值并禁用危险按钮。
       */
      setResetRevision(loaded.latest[1]?.revision ?? '')
    } catch (loadError) {
      setInfo(null)
      setLatest([])
      setResetRevision('')
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setPending(false)
    }
  }

  useEffect(() => {
    void refreshBranch(selectedBranch)
    // 回调由 App 包装，仓库切换时组件会重新挂载；这里只跟随明确的 Branch 选择。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBranch])

  const compare = async () => {
    if (!sourceBranch || !targetBranch || sourceBranch === targetBranch) return
    setPending(true)
    setError('')
    try {
      setDiff(await onLoadDiff(sourceBranch, targetBranch, diffPath))
    } catch (loadError) {
      setDiff(null)
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setPending(false)
    }
  }

  const toggleProtection = async () => {
    if (!info) return
    setPending(true)
    const succeeded = await onSetProtected(info.name, !info.protected)
    if (succeeded) await refreshBranch(info.name)
    else setPending(false)
  }

  const resetIndex = latest.findIndex((entry) => entry.revision === resetRevision)
  const resetLatest = async () => {
    if (!info || resetIndex <= 0) return
    setPending(true)
    const succeeded = await onReset(info.name, resetRevision, repositoryRevision, info.latest, resetIndex)
    if (succeeded) await refreshBranch(info.name)
    else setPending(false)
  }

  return (
    <div className="branch-collaboration">
      <section className="composition-manager">
        <header className="composition-manager__header">
          <span className="composition-manager__icon">
            <ShieldCheck size={17} />
          </span>
          <span>
            <strong>{t('branchProtectionAndLatest')}</strong>
            <small>{t('branchProtectionAndLatestHint')}</small>
          </span>
          <button
            type="button"
            aria-label={t('refresh')}
            title={t('refresh')}
            disabled={disabled || pending || !selectedBranch}
            onClick={() => void refreshBranch(selectedBranch)}
          >
            <RefreshCw size={14} />
          </button>
        </header>

        <div className="composition-form composition-form--compact">
          <label>
            <span>{t('localBranch')}</span>
            <SelectInput
              value={selectedBranch}
              disabled={disabled || pending}
              onChange={(event) => setSelectedBranch(event.target.value)}
            >
              {localBranches.map((branch) => (
                <option key={branch.id} value={branch.name}>
                  {branch.name}
                </option>
              ))}
            </SelectInput>
          </label>
          {info && (
            <div className="branch-collaboration__summary">
              <span>
                <small>{t('branchCategory')}</small>
                <strong>{info.category || '—'}</strong>
              </span>
              <span>
                <small>{t('latestRevision')}</small>
                <code title={info.latest}>{info.latest.slice(0, 12)}</code>
              </span>
              <span>
                <small>{t('protectionStatus')}</small>
                <strong>{info.protected ? t('protected') : t('unprotected')}</strong>
              </span>
            </div>
          )}
          <footer>
            <small>{info?.protected ? t('protectedBranchWriteHint') : t('unprotectedBranchWriteHint')}</small>
            <button type="button" disabled={disabled || pending || !info} onClick={() => void toggleProtection()}>
              {pending ? (
                <LoaderCircle className="spin" size={14} />
              ) : info?.protected ? (
                <ShieldOff size={14} />
              ) : (
                <ShieldCheck size={14} />
              )}
              {info?.protected ? t('removeBranchProtection') : t('protectBranch')}
            </button>
          </footer>
        </div>

        <div className="composition-form composition-form--compact branch-collaboration__reset">
          <header>
            <History size={15} />
            <span>
              <strong>{t('latestPointerHistory')}</strong>
              <small>{t('latestPointerHistoryHint')}</small>
            </span>
          </header>
          <label>
            <span>{t('resetTargetRevision')}</span>
            <SelectInput
              value={resetRevision}
              disabled={disabled || pending || latest.length < 2 || Boolean(info?.protected)}
              onChange={(event) => setResetRevision(event.target.value)}
            >
              {latest.slice(1).map((entry) => (
                <option key={`${entry.branch}:${entry.revision}`} value={entry.revision}>
                  {entry.revision.slice(0, 12)}
                </option>
              ))}
            </SelectInput>
          </label>
          <footer>
            <small>
              {resetIndex > 0 ? t('status.branchResetImpact', { count: resetIndex }) : t('noBranchResetTarget')}
            </small>
            <button
              type="button"
              className="is-danger"
              disabled={disabled || pending || !info || info.protected || resetIndex <= 0}
              onClick={() => void resetLatest()}
            >
              <Undo2 size={14} />
              {t('resetBranchLatest')}
            </button>
          </footer>
        </div>
      </section>

      <section className="composition-manager">
        <header className="composition-manager__header">
          <span className="composition-manager__icon">
            <GitCompareArrows size={17} />
          </span>
          <span>
            <strong>{t('branchDiff')}</strong>
            <small>{t('branchDiffHint')}</small>
          </span>
        </header>
        <div className="composition-form">
          <div className="composition-form__grid">
            <label>
              <span>{t('sourceBranch')}</span>
              <SelectInput value={sourceBranch} onChange={(event) => setSourceBranch(event.target.value)}>
                {localBranches.map((branch) => (
                  <option key={branch.id} value={branch.name}>
                    {branch.name}
                  </option>
                ))}
              </SelectInput>
            </label>
            <label>
              <span>{t('targetBranch')}</span>
              <SelectInput value={targetBranch} onChange={(event) => setTargetBranch(event.target.value)}>
                {localBranches.map((branch) => (
                  <option key={branch.id} value={branch.name}>
                    {branch.name}
                  </option>
                ))}
              </SelectInput>
            </label>
            <label className="is-wide">
              <span>{t('optionalRepositoryPath')}</span>
              <input
                value={diffPath}
                placeholder="Content/Characters"
                onChange={(event) => setDiffPath(event.target.value)}
              />
            </label>
          </div>
          <footer>
            <small>{sourceBranch === targetBranch ? t('chooseDifferentBranches') : t('branchDiffReadOnlyHint')}</small>
            <button
              type="button"
              className="is-primary"
              disabled={disabled || pending || !sourceBranch || !targetBranch || sourceBranch === targetBranch}
              onClick={() => void compare()}
            >
              {pending ? <LoaderCircle className="spin" size={14} /> : <GitCompareArrows size={14} />}
              {t('compareBranches')}
            </button>
          </footer>
        </div>

        {diff && <BranchDiffResult diff={diff} />}
      </section>

      {error && <p className="settings-feedback is-warning">{error}</p>}
    </div>
  )
}
