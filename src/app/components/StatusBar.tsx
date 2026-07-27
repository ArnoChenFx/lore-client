import { Activity, Cloud, Database, GitBranch, LockKeyhole } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { LoreRuntimeInfo, Repository } from '../../types'
import '../../i18n'

interface StatusBarProps {
  repository: Repository
  runtimeInfo: LoreRuntimeInfo | null
  busyLabel: string | null
  demoMode: boolean
}

export function StatusBar({ repository, runtimeInfo, busyLabel, demoMode }: StatusBarProps) {
  const { t } = useTranslation()
  const conflictLabel =
    repository.unresolvedConflictCount > 0
      ? t('status.unresolvedConflicts', { count: repository.unresolvedConflictCount })
      : repository.conflictCount > 0
        ? t('status.conflictsResolved', { count: repository.conflictCount })
        : t('noActiveConflicts')
  const remoteLabel =
    repository.remoteState === 'online'
      ? t('remoteAuthorized')
      : repository.remoteState === 'unauthorized'
        ? t('remoteAuthenticationRequired')
        : repository.remoteState === 'offline'
          ? t('offline')
          : t('localMode')
  const operationLabel = busyLabel ?? t('idle')
  const storeLabel = demoMode ? t('cache187Gb28Gb') : t('storeIsManagedByLoreCore')
  const versionLabel = `Lore Core ${runtimeInfo?.libraryVersion ?? t('checking')}${demoMode ? t('browserDemo') : ''}`

  return (
    <footer className="statusbar">
      <span title={t('status.currentBranchTooltip', { value: repository.branch })}>
        <GitBranch size={12} />
        {repository.branch}
      </span>
      <span title={t('status.remoteStatusTooltip', { value: remoteLabel })}>
        <Cloud size={12} />
        {remoteLabel}
      </span>
      <span title={t('status.operationStatusTooltip', { value: operationLabel })}>
        <Activity size={12} />
        {operationLabel}
      </span>
      <span className="statusbar__spacer" />
      <span title={t('status.storeStatusTooltip', { value: storeLabel })}>
        <Database size={12} />
        {storeLabel}
      </span>
      <span title={t('status.conflictStatusTooltip', { value: conflictLabel })}>
        <LockKeyhole size={12} />
        {conflictLabel}
      </span>
      <span
        className="statusbar__version"
        title={t('status.loreCoreVersionTooltip', {
          value: runtimeInfo?.libraryVersion ?? t('checking')
        })}
      >
        {/*
         * 原生桌面模式本身就是默认运行形态，不重复显示低价值的 “Native integration”；
         * 只有纯前端演示需要保留显式后缀，防止用户误以为页面连接了本机 Lore Core。
         */}
        {versionLabel}
      </span>
    </footer>
  )
}
