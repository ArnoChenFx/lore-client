import { CheckCircle2, Clock3, LoaderCircle, X, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { getAppLanguage, t } from '../../../i18n'
import type { LoreOperationStreamRecord, OperationContext, OperationRecord } from '../../../types'
import { resolveOperationDetail } from '../operationDetail'
import { isActiveStreamPhase, isOperationRequestActive } from '../operationHistory'
import { deriveProgressView } from '../operationProgress'
import { describeOperationProgress } from '../operationProgressText'
import { resolveLoreEventLabel, resolveLoreOperationLabel } from '../operationStreamLabels'

/** 展示本次应用会话真实执行过的操作，而不是固定的示例队列。 */
export function OperationCenter({
  operations,
  streams,
  activeRequests,
  onClear,
  onClose
}: {
  operations: OperationRecord[]
  streams: LoreOperationStreamRecord[]
  activeRequests: OperationContext[]
  onClear: () => void
  onClose: () => void
}) {
  const { i18n } = useTranslation()
  // 订阅语言变化：记录里存的是语义键，必须在当前语言下再解析。
  const language = i18n.resolvedLanguage ?? i18n.language
  const timeLocale = getAppLanguage() === 'en-US' ? 'en-US' : 'zh-CN'
  const unrepresentedRequests = activeRequests.filter(
    (context) =>
      !operations.some((record) => record.requestId === context.requestId) &&
      !streams.some((record) => record.requestId === context.requestId && isActiveStreamPhase(record.phase))
  )

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className="task-dialog operation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="operations-title"
      >
        <header className="task-dialog__header">
          <span className="task-dialog__mark">
            <Clock3 size={18} />
          </span>
          <span>
            <small>{t('session')}</small>
            <h2 id="operations-title">{t('operationHistory')}</h2>
          </span>
          <button type="button" aria-label={t('closeOperationHistory')} onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="operation-list">
          {streams.length > 0 && (
            /*
             * 实时流记录与普通操作记录已经使用相同的状态、标题和阶段摘要，
             * 不再额外插入解释栏，避免高频查看时浪费首屏纵向空间。
             */
            <div className="operation-streams">
              {streams.map((stream) => {
                const phase =
                  isActiveStreamPhase(stream.phase) && !isOperationRequestActive(stream, activeRequests)
                    ? 'ended'
                    : stream.phase
                return (
                  <article key={stream.operationId}>
                    <OperationState phase={phase} />
                    <div>
                      <strong>{resolveLoreOperationLabel(stream.operation)}</strong>
                      <small>{stream.workspaceKey ?? t('operationScopeGlobal')}</small>
                      <small>
                        {t('status.operationStreamSummary', {
                          phase: t(`operationPhase.${phase}` as never),
                          events: stream.eventCount,
                          stage: resolveLoreEventLabel(stream.lastEventTag)
                        })}
                      </small>
                      {phase === 'ended' && <small>{t('operationFinalProgressUnavailable')}</small>}
                      {stream.progress && <small>{describeStreamProgress(stream)}</small>}
                      {!stream.progress && (stream.total !== undefined || stream.bytes !== undefined) && (
                        <small>
                          {stream.current !== undefined && stream.total !== undefined
                            ? `${stream.current} / ${stream.total}`
                            : ''}
                          {stream.bytes !== undefined ? ` · ${formatOperationBytes(stream.bytes)}` : ''}
                        </small>
                      )}
                    </div>
                    <time dateTime={new Date(stream.startedAt).toISOString()}>
                      {stream.durationMs === undefined ? (phase === 'ended' ? '—' : '…') : `${stream.durationMs} ms`}
                    </time>
                  </article>
                )
              })}
            </div>
          )}
          {unrepresentedRequests.map((context) => (
            <article key={context.requestId}>
              <OperationState phase="running" />
              <div>
                <strong>{t('operationInProgress')}</strong>
                <small>{context.workspaceKey ?? t('operationScopeGlobal')}</small>
              </div>
            </article>
          ))}
          {operations.length === 0 && streams.length === 0 && activeRequests.length === 0 ? (
            <div className="dialog-empty">
              <Clock3 size={20} />
              <strong>{t('noOperationsInThisSession')}</strong>
              <small>{t('syncPushCloneMaintenanceOperations_9f11')}</small>
            </div>
          ) : (
            operations.map((operation) => {
              const phase =
                operation.status === 'running' && !isOperationRequestActive(operation, activeRequests)
                  ? 'ended'
                  : operation.status
              return (
                <article key={`${operation.requestId}-${language}`}>
                  <OperationState phase={phase} />
                  <div>
                    <strong>{t(operation.labelKey as never)}</strong>
                    <small>{operation.workspaceKey ?? t('operationScopeGlobal')}</small>
                    {phase === 'ended' && <small>{t('operationPhase.ended')}</small>}
                    <small>{resolveOperationDetail(operation.detail)}</small>
                  </div>
                  <time dateTime={new Date(operation.startedAt).toISOString()}>
                    {operation.durationMs === undefined
                      ? new Date(operation.startedAt).toLocaleTimeString(timeLocale, { hour12: false })
                      : `${operation.durationMs} ms`}
                  </time>
                </article>
              )
            })
          )}
        </div>
        {(operations.length > 0 || streams.length > 0) && (
          <footer className="task-dialog__footer">
            <button type="button" onClick={onClear}>
              {t('clearCompletedRecords')}
            </button>
          </footer>
        )}
      </section>
    </div>
  )
}

function OperationState({ phase }: { phase: LoreOperationStreamRecord['phase'] | 'ended' }) {
  return (
    <span className={`operation-state is-${phase}`}>
      {phase === 'queued' || phase === 'ended' ? (
        <Clock3 size={15} />
      ) : phase === 'running' || phase === 'streaming' ? (
        <LoaderCircle className="is-spinning" size={15} />
      ) : phase === 'succeeded' ? (
        <CheckCircle2 size={15} />
      ) : (
        <XCircle size={15} />
      )}
    </span>
  )
}

function formatOperationBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 ** 2) return `${(bytes / 1_024).toFixed(1)} KB`
  if (bytes < 1_024 ** 3) return `${(bytes / 1_024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1_024 ** 3).toFixed(1)} GB`
}

/** 历史记录里的进度以“最后一次快照”为准：不再累加墙钟间隔，也不会误报停滞。 */
function describeStreamProgress(stream: LoreOperationStreamRecord): string {
  const progress = stream.progress
  const view = deriveProgressView(stream, stream.progressAt ?? 0)
  return progress && view ? describeOperationProgress(stream.lastEventTag, progress, view).detail : ''
}
