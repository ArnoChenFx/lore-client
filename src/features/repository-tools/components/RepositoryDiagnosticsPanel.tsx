import { FileSearch, HardDrive, LoaderCircle, RefreshCw, ShieldAlert, Stethoscope, Wrench } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { confirmLocalized } from '../../../i18n'
import { NumberInput, TextButton, TextInput } from '../../../shared/ui'
import type { LoreDiagnosticReport, LoreRepositoryInstance } from '../../../types'

interface RepositoryDiagnosticsPanelProps {
  repositoryName: string
  currentRevision?: string
  onVerify: (path: string, heal: boolean) => Promise<LoreDiagnosticReport>
  onVerifyFragment: (hash: string, context: string, heal: boolean) => Promise<LoreDiagnosticReport>
  onDump: (revision: string, path: string, maxDepth: number) => Promise<LoreDiagnosticReport>
  onListInstances: () => Promise<LoreRepositoryInstance[]>
  onPruneInstances: () => Promise<boolean>
  onUpdateInstancePath: () => Promise<boolean>
}

/** 只读诊断、受控 Heal 与 Instance 维护的统一高级工作区。 */
export function RepositoryDiagnosticsPanel({
  repositoryName,
  currentRevision,
  onVerify,
  onVerifyFragment,
  onDump,
  onListInstances,
  onPruneInstances,
  onUpdateInstancePath
}: RepositoryDiagnosticsPanelProps) {
  const { t } = useTranslation()
  const [path, setPath] = useState('')
  const [report, setReport] = useState<LoreDiagnosticReport | null>(null)
  const [verifiedPath, setVerifiedPath] = useState<string | null>(null)
  const [fragmentHash, setFragmentHash] = useState('')
  const [fragmentContext, setFragmentContext] = useState('')
  const [dumpRevision, setDumpRevision] = useState(currentRevision ?? '')
  const [dumpPath, setDumpPath] = useState('')
  const [dumpDepth, setDumpDepth] = useState(4)
  const [instances, setInstances] = useState<LoreRepositoryInstance[]>([])
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    // 诊断草稿与事件日志只能属于当前仓库，切换项目时不得复用上一仓库的
    // 预检凭据；否则相同路径可能错误解锁 Heal。
    setPath('')
    setReport(null)
    setVerifiedPath(null)
    setFragmentHash('')
    setFragmentContext('')
    setDumpRevision(currentRevision ?? '')
    setDumpPath('')
    setInstances([])
    setError('')
  }, [currentRevision, repositoryName])

  const runReport = async (name: string, task: () => Promise<LoreDiagnosticReport>) => {
    try {
      setPending(name)
      setError('')
      setReport(await task())
    } catch (runError) {
      setError(readPanelError(runError))
    } finally {
      setPending('')
    }
  }

  const refreshInstances = async () => {
    try {
      setPending('instances')
      setError('')
      setInstances(await onListInstances())
    } catch (loadError) {
      setError(readPanelError(loadError))
    } finally {
      setPending('')
    }
  }

  const runInstanceMutation = async (name: string, task: () => Promise<boolean>) => {
    try {
      setPending(name)
      setError('')
      if (await task()) {
        // 写操作成功后重新读取 Lore 的完整 Instance 集合，不局部删除或改写行。
        setInstances(await onListInstances())
      }
    } catch (mutationError) {
      setError(readPanelError(mutationError))
    } finally {
      setPending('')
    }
  }

  const staleInstances = instances.filter((instance) => instance.stale)

  return (
    <section className="repository-diagnostics">
      <header className="tool-section-heading">
        <span>
          <Stethoscope size={16} />
          <strong>{t('advancedDiagnostics')}</strong>
        </span>
        <small>{t('advancedDiagnosticsDescription')}</small>
      </header>

      {error && <div className="tool-inline-error">{error}</div>}

      <div className="repository-diagnostics__grid">
        <section className="diagnostic-module diagnostic-module--form">
          <header>
            <span className="diagnostic-module__icon">
              <FileSearch size={15} />
            </span>
            <h3>{t('repositoryStateVerification')}</h3>
          </header>
          <div className="diagnostic-module__fields">
            <label className="tool-field">
              <span>{t('repositoryRelativePathOptional')}</span>
              <TextInput value={path} spellCheck={false} onChange={(event) => setPath(event.target.value)} />
            </label>
          </div>
          <footer className="tool-action-row">
            <TextButton
              disabled={Boolean(pending)}
              onClick={() =>
                void runReport('verify', async () => {
                  const next = await onVerify(path, false)
                  setVerifiedPath(path.trim())
                  return next
                })
              }
            >
              {pending === 'verify' ? <LoaderCircle className="is-spinning" size={14} /> : <ShieldAlert size={14} />}
              {t('verifyReadOnly')}
            </TextButton>
            <TextButton
              variant="danger"
              disabled={Boolean(pending) || verifiedPath !== path.trim()}
              title={verifiedPath !== path.trim() ? t('healRequiresMatchingPreflight') : undefined}
              onClick={() => {
                if (
                  !confirmLocalized(
                    t('confirm.healRepositoryPath', {
                      repository: repositoryName,
                      path: path.trim() || t('entireRepository')
                    })
                  )
                ) {
                  return
                }
                void runReport('heal', () => onVerify(path, true))
              }}
            >
              <Wrench size={14} />
              {t('healDetectedProblems')}
            </TextButton>
          </footer>
        </section>

        <section className="diagnostic-module diagnostic-module--form">
          <header>
            <span className="diagnostic-module__icon">
              <HardDrive size={15} />
            </span>
            <h3>{t('fragmentVerification')}</h3>
          </header>
          <div className="diagnostic-module__fields diagnostic-module__fields--split">
            <label className="tool-field">
              <span>{t('fragmentHash')}</span>
              <TextInput
                value={fragmentHash}
                spellCheck={false}
                onChange={(event) => setFragmentHash(event.target.value)}
              />
            </label>
            <label className="tool-field">
              <span>{t('fragmentContextOptional')}</span>
              <TextInput
                value={fragmentContext}
                spellCheck={false}
                onChange={(event) => setFragmentContext(event.target.value)}
              />
            </label>
          </div>
          <footer className="tool-action-row">
            <TextButton
              disabled={Boolean(pending) || !fragmentHash.trim()}
              onClick={() => void runReport('fragment', () => onVerifyFragment(fragmentHash, fragmentContext, false))}
            >
              {t('verifyFragment')}
            </TextButton>
          </footer>
        </section>

        <section className="diagnostic-module diagnostic-module--form">
          <header>
            <span className="diagnostic-module__icon">
              <Stethoscope size={15} />
            </span>
            <h3>{t('repositoryStateDump')}</h3>
          </header>
          <div className="diagnostic-module__fields diagnostic-module__fields--dump">
            <label className="tool-field">
              <span>{t('revision')}</span>
              <TextInput
                value={dumpRevision}
                spellCheck={false}
                onChange={(event) => setDumpRevision(event.target.value)}
              />
            </label>
            <label className="tool-field">
              <span>{t('repositoryRelativePathOptional')}</span>
              <TextInput value={dumpPath} spellCheck={false} onChange={(event) => setDumpPath(event.target.value)} />
            </label>
            <label className="tool-field">
              <span>{t('maximumDepth')}</span>
              <NumberInput
                min={1}
                max={32}
                value={dumpDepth}
                onChange={(event) => setDumpDepth(Math.max(1, Math.min(32, Number(event.target.value) || 4)))}
              />
            </label>
          </div>
          <footer className="tool-action-row">
            <TextButton
              disabled={Boolean(pending)}
              onClick={() => void runReport('dump', () => onDump(dumpRevision, dumpPath, dumpDepth))}
            >
              {t('readStateDump')}
            </TextButton>
          </footer>
        </section>

        <section className="diagnostic-module diagnostic-module--instances">
          <header>
            <span className="diagnostic-module__icon">
              <HardDrive size={15} />
            </span>
            <h3>{t('repositoryInstances')}</h3>
          </header>
          <div className="tool-action-row diagnostic-module__instance-actions">
            <TextButton disabled={Boolean(pending)} onClick={() => void refreshInstances()}>
              {pending === 'instances' ? <LoaderCircle className="is-spinning" size={14} /> : <RefreshCw size={14} />}
              {t('refresh')}
            </TextButton>
            <TextButton
              disabled={Boolean(pending)}
              onClick={() => void runInstanceMutation('update-instance', onUpdateInstancePath)}
            >
              {t('updateCurrentInstancePath')}
            </TextButton>
          </div>
          <ul className="repository-instance-list">
            {instances.map((instance) => (
              <li key={instance.id} className={instance.stale ? 'is-stale' : ''}>
                <strong>{instance.path || t('unknownPath')}</strong>
                <small>
                  {instance.branchName || '—'} · {instance.revision.slice(0, 8) || '—'}
                </small>
                {instance.stale && <em>{t('stale')}</em>}
              </li>
            ))}
          </ul>
          {/*
           * 清理失效 Instance 是不可逆维护动作，必须与刷新、路径更新等普通操作
           * 分离到底部危险操作区；这也让同排卡片的操作基线保持稳定。
           */}
          <footer className="tool-action-row">
            <TextButton
              variant="danger"
              disabled={Boolean(pending) || staleInstances.length === 0}
              onClick={() => {
                if (
                  !confirmLocalized(
                    t('confirm.pruneRepositoryInstances', {
                      repository: repositoryName,
                      count: staleInstances.length,
                      paths: staleInstances.map((instance) => instance.path).join('\n')
                    })
                  )
                ) {
                  return
                }
                void runInstanceMutation('prune-instances', onPruneInstances)
              }}
            >
              {t('pruneStaleInstances')}
            </TextButton>
          </footer>
        </section>
      </div>

      <section className="diagnostic-report">
        <h3>{t('diagnosticLog')}</h3>
        {!report ? (
          <div className="tool-empty-state">{t('runDiagnosticToSeeLog')}</div>
        ) : (
          <>
            <small>
              {report.operation} · {report.durationMs} ms
            </small>
            <ol>
              {report.findings.map((finding) => (
                <li
                  key={`${finding.kind}:${finding.summary}:${finding.detail ?? ''}`}
                  className={finding.error ? 'is-error' : ''}
                >
                  <strong>{finding.kind}</strong>
                  <span>{finding.summary}</span>
                  {finding.detail && <pre>{finding.detail}</pre>}
                </li>
              ))}
            </ol>
          </>
        )}
      </section>
    </section>
  )
}

function readPanelError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error && 'message' in error) return String(error.message)
  return String(error)
}
