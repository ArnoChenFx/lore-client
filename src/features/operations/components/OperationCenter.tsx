import { CheckCircle2, Clock3, LoaderCircle, X, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { getAppLanguage, t } from '../../../i18n'
import type { LoreOperationStreamRecord, OperationRecord } from '../../../types'
import { resolveOperationDetail } from '../operationDetail'
import { resolveLoreEventLabel, resolveLoreOperationLabel } from '../operationStreamLabels'

/** 展示本次应用会话真实执行过的操作，而不是固定的示例队列。 */
export function OperationCenter({
  operations,
  streams,
  onClear,
  onClose
}: {
  operations: OperationRecord[]
  streams: LoreOperationStreamRecord[]
  onClear: () => void
  onClose: () => void
}) {
  const { i18n } = useTranslation()
  // 订阅语言变化：记录里存的是语义键，必须在当前语言下再解析。
  const language = i18n.resolvedLanguage ?? i18n.language
  const timeLocale = getAppLanguage() === 'en-US' ? 'en-US' : 'zh-CN'

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
              {streams.map((stream) => (
                <article key={stream.operationId}>
                  <span className={`operation-state is-${stream.phase}`}>
                    {stream.phase === 'queued' ? (
                      <Clock3 size={15} />
                    ) : stream.phase === 'running' || stream.phase === 'streaming' ? (
                      <LoaderCircle className="is-spinning" size={15} />
                    ) : stream.phase === 'succeeded' ? (
                      <CheckCircle2 size={15} />
                    ) : (
                      <XCircle size={15} />
                    )}
                  </span>
                  <div>
                    <strong>{resolveLoreOperationLabel(stream.operation)}</strong>
                    <small>
                      {t('status.operationStreamSummary', {
                        phase: t(`operationPhase.${stream.phase}` as never),
                        events: stream.eventCount,
                        stage: resolveLoreEventLabel(stream.lastEventTag)
                      })}
                    </small>
                    {(stream.total !== undefined || stream.bytes !== undefined) && (
                      <small>
                        {stream.current !== undefined && stream.total !== undefined
                          ? `${stream.current} / ${stream.total}`
                          : ''}
                        {stream.bytes !== undefined ? ` · ${formatOperationBytes(stream.bytes)}` : ''}
                      </small>
                    )}
                  </div>
                  <time dateTime={new Date(stream.startedAt).toISOString()}>
                    {stream.durationMs === undefined ? '…' : `${stream.durationMs} ms`}
                  </time>
                </article>
              ))}
            </div>
          )}
          {operations.length === 0 && streams.length === 0 ? (
            <div className="dialog-empty">
              <Clock3 size={20} />
              <strong>{t('noOperationsInThisSession')}</strong>
              <small>{t('syncPushCloneMaintenanceOperations_9f11')}</small>
            </div>
          ) : (
            operations.map((operation) => (
              <article key={`${operation.id}-${language}`}>
                <span className={`operation-state is-${operation.status}`}>
                  {operation.status === 'running' ? (
                    <LoaderCircle className="is-spinning" size={15} />
                  ) : operation.status === 'succeeded' ? (
                    <CheckCircle2 size={15} />
                  ) : (
                    <XCircle size={15} />
                  )}
                </span>
                <div>
                  <strong>{t(operation.labelKey as never)}</strong>
                  <small>{resolveOperationDetail(operation.detail)}</small>
                </div>
                <time dateTime={new Date(operation.startedAt).toISOString()}>
                  {operation.durationMs === undefined
                    ? new Date(operation.startedAt).toLocaleTimeString(timeLocale, { hour12: false })
                    : `${operation.durationMs} ms`}
                </time>
              </article>
            ))
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

function formatOperationBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 ** 2) return `${(bytes / 1_024).toFixed(1)} KB`
  if (bytes < 1_024 ** 3) return `${(bytes / 1_024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1_024 ** 3).toFixed(1)} GB`
}
