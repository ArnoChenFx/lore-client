import { Database, File, GitBranch, GitCommitHorizontal, LoaderCircle, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAdjustFromProps } from '../../../hooks/useAdjustFromProps'
import { SelectInput, TextButton, TextInput } from '../../../shared/ui'
import type { Branch, LoreMetadataEntry, LoreMetadataScope, Revision } from '../../../types'

interface MetadataBrowserPanelProps {
  branches: Branch[]
  revisions: Revision[]
  currentRevision?: string
  onLoad: (scope: LoreMetadataScope, target?: string, revision?: string) => Promise<LoreMetadataEntry[]>
}

const scopeIcons = {
  repository: <Database size={14} />,
  branch: <GitBranch size={14} />,
  revision: <GitCommitHorizontal size={14} />,
  file: <File size={14} />
} as const

interface ResolvedMetadataRequest {
  scope: LoreMetadataScope
  target?: string
  revision?: string
}

/**
 * 把四类控件草稿归一化成后端唯一请求。
 *
 * Revision 下拉框与文件 Revision 输入共享本地状态，但两者的参数语义不同：
 * Revision 对象只传精确 Revision，文件对象才同时传路径与可选 Revision。
 * 返回 null 表示参数尚不完整，自动读取应等待用户继续输入。
 */
export function resolveMetadataRequest(
  scope: LoreMetadataScope,
  target: string,
  revision: string
): ResolvedMetadataRequest | null {
  const normalizedTarget = target.trim()
  const normalizedRevision = revision.trim()

  if (scope === 'repository') return { scope }
  if (scope === 'branch') return normalizedTarget ? { scope, target: normalizedTarget } : null
  if (scope === 'revision') {
    const selectedRevision = normalizedTarget || normalizedRevision
    return selectedRevision ? { scope, target: selectedRevision, revision: selectedRevision } : null
  }
  return normalizedTarget
    ? {
        scope,
        target: normalizedTarget,
        revision: normalizedRevision || undefined
      }
    : null
}

/** 四类 Lore 元数据的统一只读浏览器。 */
export function MetadataBrowserPanel({ branches, revisions, currentRevision, onLoad }: MetadataBrowserPanelProps) {
  const { t } = useTranslation()
  const [scope, setScope] = useState<LoreMetadataScope>('repository')
  const [target, setTarget] = useState('')
  const [revision, setRevision] = useState(currentRevision ?? '')
  const [entries, setEntries] = useState<LoreMetadataEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const loadSequenceRef = useRef(0)
  const autoLoadTimerRef = useRef<number | null>(null)
  const onLoadRef = useRef(onLoad)
  // 在 effect 内维护“最新回调”引用：load 的异步回调始终读到当前 onLoad，而回调
  // 本身不进入 effect 依赖，避免请求因回调引用变化重复发出。
  useEffect(() => {
    onLoadRef.current = onLoad
  })

  // 当前 Revision 变化时重置已选 Revision 草稿；值相同时不触碰用户输入。
  useAdjustFromProps(currentRevision ?? '', () => {
    setRevision(currentRevision ?? '')
  })

  const request = resolveMetadataRequest(scope, target, revision)
  const requestScope = request?.scope
  const requestTarget = request?.target
  const requestRevision = request?.revision

  const load = useCallback(async (nextScope: LoreMetadataScope, nextTarget?: string, nextRevision?: string) => {
    const sequence = loadSequenceRef.current + 1
    loadSequenceRef.current = sequence
    try {
      setLoading(true)
      setError('')
      setEntries([])
      const nextEntries = await onLoadRef.current(nextScope, nextTarget, nextRevision)
      // 参数连续变化时，较早请求即使最后返回，也不能覆盖当前对象的结果。
      if (sequence !== loadSequenceRef.current) return
      setEntries(nextEntries)
    } catch (loadError) {
      if (sequence !== loadSequenceRef.current) return
      setEntries([])
      setError(readPanelError(loadError))
    } finally {
      if (sequence === loadSequenceRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (autoLoadTimerRef.current !== null) {
      window.clearTimeout(autoLoadTimerRef.current)
      autoLoadTimerRef.current = null
    }

    if (!requestScope) {
      // 参数失效时同时作废在途请求，避免旧对象的响应重新填入空参数页面。
      loadSequenceRef.current += 1
      // 清空展示状态放到微任务，执行前请求序号已作废，不会与后续请求竞争。
      queueMicrotask(() => {
        setLoading(false)
        setEntries([])
        setError('')
      })
      return
    }

    // 下拉选择立即读取；文件路径和 Revision 是自由输入，短暂防抖可避免逐字符调用 Lore。
    const delay = requestScope === 'file' ? 240 : 0
    autoLoadTimerRef.current = window.setTimeout(() => {
      autoLoadTimerRef.current = null
      void load(requestScope, requestTarget, requestRevision)
    }, delay)

    return () => {
      if (autoLoadTimerRef.current !== null) {
        window.clearTimeout(autoLoadTimerRef.current)
        autoLoadTimerRef.current = null
      }
      // effect 切换参数时立即让上一个请求失效，而不是等待下一次请求实际发出。
      loadSequenceRef.current += 1
    }
  }, [load, requestRevision, requestScope, requestTarget])

  const retry = () => {
    if (!requestScope) return
    if (autoLoadTimerRef.current !== null) {
      window.clearTimeout(autoLoadTimerRef.current)
      autoLoadTimerRef.current = null
    }
    void load(requestScope, requestTarget, requestRevision)
  }

  return (
    <section className="metadata-browser">
      <header className="tool-section-heading">
        <span>
          <Database size={16} />
          <strong>{t('metadataBrowser')}</strong>
        </span>
        <small>{t('metadataBrowserReadOnlyDescription')}</small>
      </header>

      <div className="metadata-browser__controls">
        <label className="tool-field">
          <span>{t('metadataObjectType')}</span>
          <SelectInput
            value={scope}
            onChange={(event) => {
              const nextScope = event.target.value as LoreMetadataScope
              setScope(nextScope)
              setEntries([])
              setError('')
              setTarget(
                nextScope === 'branch'
                  ? (branches.find((branch) => !branch.remote && !branch.archived)?.name ?? '')
                  : nextScope === 'revision'
                    ? (currentRevision ?? revisions[0]?.id ?? '')
                    : ''
              )
            }}
          >
            {(['repository', 'branch', 'revision', 'file'] as const).map((value) => (
              <option key={value} value={value}>
                {t(`metadataScope.${value}` as never)}
              </option>
            ))}
          </SelectInput>
        </label>

        {scope === 'branch' && (
          <label className="tool-field">
            <span>{t('branch')}</span>
            <SelectInput value={target} onChange={(event) => setTarget(event.target.value)}>
              {branches
                .filter((branch) => !branch.remote && !branch.archived)
                .map((branch) => (
                  <option key={branch.id} value={branch.name}>
                    {branch.name}
                  </option>
                ))}
            </SelectInput>
          </label>
        )}

        {scope === 'revision' && (
          <label className="tool-field">
            <span>{t('revision')}</span>
            <SelectInput value={target || revision} onChange={(event) => setTarget(event.target.value)}>
              {revisions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.shortId} · {item.title}
                </option>
              ))}
            </SelectInput>
          </label>
        )}

        {scope === 'file' && (
          <>
            <label className="tool-field">
              <span>{t('repositoryRelativePath')}</span>
              <TextInput
                value={target}
                spellCheck={false}
                placeholder="Content/Characters/Hero.uasset"
                onChange={(event) => setTarget(event.target.value)}
              />
            </label>
            <label className="tool-field">
              <span>{t('revision')}</span>
              <TextInput
                value={revision}
                spellCheck={false}
                placeholder={currentRevision}
                onChange={(event) => setRevision(event.target.value)}
              />
            </label>
          </>
        )}

        <TextButton
          variant="primary"
          className="metadata-browser__read"
          disabled={loading || !requestScope}
          onClick={retry}
        >
          {loading ? <LoaderCircle className="is-spinning" size={14} /> : <RefreshCw size={14} />}
          {t('readMetadata')}
        </TextButton>
      </div>

      <div className="metadata-browser__result">
        {error ? (
          <div className="tool-inline-error">{error}</div>
        ) : entries.length === 0 ? (
          <div className="tool-empty-state">
            {scopeIcons[scope]}
            <span>{t('metadataEmptyOrNotLoaded')}</span>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t('metadataKey')}</th>
                <th>{t('type')}</th>
                <th>{t('value')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={`${entry.key}:${entry.type}`}>
                  <td>
                    <code>{entry.key}</code>
                  </td>
                  <td>{entry.type}</td>
                  <td>
                    <code>{entry.value || '—'}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}

function readPanelError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error && 'message' in error) return String(error.message)
  return String(error)
}
