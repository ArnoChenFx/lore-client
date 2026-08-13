import { Binary, FileSearch, History, Info, LoaderCircle, PencilLine, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAdjustFromProps } from '../../../hooks/useAdjustFromProps'
import { SelectInput } from '../../../shared/ui'
import type { LoreRevisionInfo, Revision } from '../../../types'

interface RevisionRecoveryPanelProps {
  currentRevision: string
  revisions: Revision[]
  disabled: boolean
  onLoadInfo: (revision: string) => Promise<LoreRevisionInfo>
  onFindNumber: (number: number) => Promise<string>
  onFindMetadata: (key: string, value?: string) => Promise<string>
  onAmend: (message: string) => Promise<boolean>
  onBisect: (start: string, end: string) => Promise<boolean>
  onRestore: (message: string) => Promise<boolean>
  onLocate: (revision: string) => void
}

/** Revision 的发现、审计和三种高影响写操作入口。 */
export function RevisionRecoveryPanel({
  currentRevision,
  revisions,
  disabled,
  onLoadInfo,
  onFindNumber,
  onFindMetadata,
  onAmend,
  onBisect,
  onRestore,
  onLocate
}: RevisionRecoveryPanelProps) {
  const { t } = useTranslation()
  const [selectedRevision, setSelectedRevision] = useState(currentRevision || revisions[0]?.id || '')
  const [info, setInfo] = useState<LoreRevisionInfo | null>(null)
  const [numberQuery, setNumberQuery] = useState('')
  const [metadataKey, setMetadataKey] = useState('')
  const [metadataValue, setMetadataValue] = useState('')
  const [findResult, setFindResult] = useState('')
  const [amendMessage, setAmendMessage] = useState('')
  const [restoreMessage, setRestoreMessage] = useState('')
  const [goodRevision, setGoodRevision] = useState(revisions.at(-1)?.id ?? '')
  const [badRevision, setBadRevision] = useState(currentRevision || revisions[0]?.id || '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  // 自动读取的代际标记：记录最后一次发起的自动读取目标，锚点漂移后旧响应不写回。
  const autoReadRevisionRef = useRef(currentRevision)
  // isCurrent 由调用方提供：自动读取校验锚点是否仍是最新；手动“加载信息”按钮
  // 不传参（默认恒真），读取期间用户切换 Revision 不会丢弃手动选择的结果。
  const loadInfo = useCallback(
    async (revision: string, isCurrent: (revision: string) => boolean = () => true) => {
      if (!revision) return
      setPending(true)
      setError('')
      try {
        const info = await onLoadInfo(revision)
        if (!isCurrent(revision)) return
        setInfo(info)
      } catch (loadError) {
        if (!isCurrent(revision)) return
        setInfo(null)
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      } finally {
        if (isCurrent(revision)) {
          setPending(false)
        }
      }
    },
    [onLoadInfo]
  )

  // 当前 Revision 变化时重置已选修订。
  useAdjustFromProps(currentRevision, () => {
    setSelectedRevision(currentRevision)
  })

  // 维护“最新 loadInfo”引用：按钮点击直接使用当前闭包，异步读取 effect 只跟随
  // 真实工作区锚点 currentRevision，父级回调引用变化（如仓库快照刷新）不会触发重复读取。
  const loadInfoRef = useRef(loadInfo)
  useEffect(() => {
    loadInfoRef.current = loadInfo
  })

  useEffect(() => {
    // 发起前与结果返回时都校验锚点：快速连续切换 Revision 时，已被取代的读取不再
    // 发起，在途的旧锚点慢响应也不会乱序覆盖新值。
    autoReadRevisionRef.current = currentRevision
    const requestedRevision = currentRevision
    queueMicrotask(() => {
      if (autoReadRevisionRef.current !== requestedRevision) return
      void loadInfoRef.current(requestedRevision, (revision) => autoReadRevisionRef.current === revision)
    })
  }, [currentRevision])

  const runFind = async (mode: 'number' | 'metadata') => {
    setPending(true)
    setError('')
    setFindResult('')
    try {
      const result =
        mode === 'number' ? await onFindNumber(Number(numberQuery)) : await onFindMetadata(metadataKey, metadataValue)
      setFindResult(result)
    } catch (findError) {
      setError(findError instanceof Error ? findError.message : String(findError))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="revision-recovery">
      <section className="composition-manager">
        <header className="composition-manager__header">
          <span className="composition-manager__icon">
            <Info size={17} />
          </span>
          <span>
            <strong>{t('revisionInformation')}</strong>
            <small>{t('revisionInformationHint')}</small>
          </span>
        </header>
        <div className="composition-form composition-form--compact">
          <label>
            <span>{t('revision')}</span>
            <SelectInput value={selectedRevision} onChange={(event) => setSelectedRevision(event.target.value)}>
              {revisions.map((revision) => (
                <option key={revision.id} value={revision.id}>
                  {revision.shortId} · {revision.title}
                </option>
              ))}
            </SelectInput>
          </label>
          <footer>
            <small>{t('revisionInfoIncludesDeltaMetadata')}</small>
            <button
              type="button"
              disabled={disabled || pending || !selectedRevision}
              onClick={() => void loadInfo(selectedRevision)}
            >
              {pending ? <LoaderCircle className="spin" size={14} /> : <Info size={14} />}
              {t('loadInformation')}
            </button>
          </footer>
        </div>
        {info && (
          <div className="revision-recovery__info">
            <span>
              <small>{t('revision')}</small>
              <code>{info.revision}</code>
            </span>
            <span>
              <small>{t('revisionNumber')}</small>
              <strong>#{info.revisionNumber}</strong>
            </span>
            <span>
              <small>{t('parentRevisions')}</small>
              <code>{info.parentIds.map((parent) => parent.slice(0, 12)).join(', ') || '—'}</code>
            </span>
            <span>
              <small>{t('changedFiles')}</small>
              <strong>{info.deltas.filter((delta) => delta.file).length}</strong>
            </span>
            <span className="is-wide">
              <small>{t('revisionMetadata')}</small>
              <code>
                {Object.entries(info.metadata)
                  .map(([key, value]) => `${key}=${String(value)}`)
                  .join(' · ') || '—'}
              </code>
            </span>
          </div>
        )}
      </section>

      <section className="composition-manager">
        <header className="composition-manager__header">
          <span className="composition-manager__icon">
            <FileSearch size={17} />
          </span>
          <span>
            <strong>{t('findRevision')}</strong>
            <small>{t('findRevisionCurrentBranchHint')}</small>
          </span>
        </header>
        <div className="revision-recovery__find">
          <form
            className="composition-form revision-recovery__query revision-recovery__query--number"
            onSubmit={(event) => {
              event.preventDefault()
              void runFind('number')
            }}
          >
            <label>
              <span>{t('revisionNumber')}</span>
              <input
                min={1}
                type="number"
                value={numberQuery}
                onChange={(event) => setNumberQuery(event.target.value)}
              />
            </label>
            <button type="submit" disabled={disabled || pending || Number(numberQuery) <= 0}>
              {t('find')}
            </button>
          </form>
          <form
            className="composition-form revision-recovery__query revision-recovery__query--metadata"
            onSubmit={(event) => {
              event.preventDefault()
              void runFind('metadata')
            }}
          >
            <label>
              <span>{t('metadataKey')}</span>
              <input value={metadataKey} onChange={(event) => setMetadataKey(event.target.value)} />
            </label>
            <label>
              <span>{t('metadataValueOptional')}</span>
              <input value={metadataValue} onChange={(event) => setMetadataValue(event.target.value)} />
            </label>
            <button type="submit" disabled={disabled || pending || !metadataKey.trim()}>
              {t('find')}
            </button>
          </form>
        </div>
        {findResult && (
          <button
            type="button"
            className="revision-recovery__result"
            onClick={() => {
              setSelectedRevision(findResult)
              onLocate(findResult)
              void loadInfo(findResult)
            }}
          >
            <FileSearch size={14} />
            <code>{findResult}</code>
            <small>{t('locateAndInspectRevision')}</small>
          </button>
        )}
      </section>

      <section className="composition-manager">
        <header className="composition-manager__header">
          <span className="composition-manager__icon">
            <History size={17} />
          </span>
          <span>
            <strong>{t('revisionRecoveryActions')}</strong>
            <small>{t('revisionRecoveryActionsHint')}</small>
          </span>
        </header>
        <div className="revision-recovery__actions">
          <form
            className="composition-form"
            onSubmit={async (event) => {
              event.preventDefault()
              setPending(true)
              await onAmend(amendMessage)
              setPending(false)
            }}
          >
            <header>
              <PencilLine size={15} />
              <strong>{t('amendLatestMessage')}</strong>
            </header>
            <textarea value={amendMessage} onChange={(event) => setAmendMessage(event.target.value)} />
            <small>{t('amendLatestMessageHint')}</small>
            <button type="submit" disabled={disabled || pending || !amendMessage.trim()}>
              {t('amend')}
            </button>
          </form>

          <form
            className="composition-form"
            onSubmit={async (event) => {
              event.preventDefault()
              setPending(true)
              await onBisect(goodRevision, badRevision)
              setPending(false)
            }}
          >
            <header>
              <Binary size={15} />
              <strong>{t('bisectOneStep')}</strong>
            </header>
            <label>
              <span>{t('knownGoodRevision')}</span>
              <SelectInput value={goodRevision} onChange={(event) => setGoodRevision(event.target.value)}>
                {revisions.map((revision) => (
                  <option key={revision.id} value={revision.id}>
                    {revision.shortId} · {revision.title}
                  </option>
                ))}
              </SelectInput>
            </label>
            <label>
              <span>{t('knownBadRevision')}</span>
              <SelectInput value={badRevision} onChange={(event) => setBadRevision(event.target.value)}>
                {revisions.map((revision) => (
                  <option key={revision.id} value={revision.id}>
                    {revision.shortId} · {revision.title}
                  </option>
                ))}
              </SelectInput>
            </label>
            <small>{t('bisectOneStepHint')}</small>
            <button type="submit" disabled={disabled || pending || !goodRevision || goodRevision === badRevision}>
              {t('syncToBisectMidpoint')}
            </button>
          </form>

          <form
            className="composition-form"
            onSubmit={async (event) => {
              event.preventDefault()
              setPending(true)
              await onRestore(restoreMessage)
              setPending(false)
            }}
          >
            <header>
              <RotateCcw size={15} />
              <strong>{t('restoreCheckedOutRevision')}</strong>
            </header>
            <textarea value={restoreMessage} onChange={(event) => setRestoreMessage(event.target.value)} />
            <small>{t('restoreCheckedOutRevisionHint')}</small>
            <button type="submit" className="is-danger" disabled={disabled || pending || !restoreMessage.trim()}>
              {t('restoreAsNewRevision')}
            </button>
          </form>
        </div>
      </section>

      {error && <p className="settings-feedback is-warning">{error}</p>}
    </div>
  )
}
