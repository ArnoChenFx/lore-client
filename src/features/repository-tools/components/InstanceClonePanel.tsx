import { CopyPlus, FolderOpen, LoaderCircle, ScanSearch } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { confirmLocalized } from '../../../i18n'
import { formatBytes } from '../../../shared/lib'
import { CheckboxInput, TextButton, TextInput } from '../../../shared/ui'
import type {
  InstanceCloneRequest,
  LoreInstanceCloneMethod,
  LoreInstanceClonePreview,
  LoreInstanceCloneResult
} from '../../../types'

interface InstanceClonePanelProps {
  repositoryName: string
  /** 同一页面上的其它维护操作正在运行时禁用，避免两个写操作排队争抢同一把 Store 锁。 */
  busy?: boolean
  onSelectParent: () => Promise<string | null>
  onPreview: (request: InstanceCloneRequest) => Promise<LoreInstanceClonePreview>
  onClone: (request: InstanceCloneRequest) => Promise<LoreInstanceCloneResult>
  /** 克隆成功后通知父组件重新读取 Lore 的完整 Instance 集合。 */
  onCloned?: () => void
}

/** 预检只对产生它的那组输入有效；比较时忽略首尾空白，与提交时的规范化保持一致。 */
function sameRequest(left: InstanceCloneRequest, right: InstanceCloneRequest): boolean {
  return (
    left.parentDirectory.trim() === right.parentDirectory.trim() &&
    left.directoryName.trim() === right.directoryName.trim() &&
    left.allowCopy === right.allowCopy
  )
}

function methodLabelKey(
  method: LoreInstanceCloneMethod
): 'instanceCloneMethodSharesBlocks' | 'instanceCloneMethodCopiesBytes' | 'instanceCloneMethodUnsupported' {
  if (method === 'sharesBlocks') return 'instanceCloneMethodSharesBlocks'
  if (method === 'copiesBytes') return 'instanceCloneMethodCopiesBytes'
  return 'instanceCloneMethodUnsupported'
}

/** Lore 对“复制字节”拒绝时使用的状态码：9 为不支持（未允许复制），118 为目标卷空间不足。 */
const STATUS_NOT_SUPPORTED = 9
const STATUS_OVERSIZED = 118

/**
 * 实例克隆：把当前 Instance 复制成同一共享 Store 上的独立工作副本。
 *
 * 流程是“预检（Lore dry run）→ 用户确认 → 真实克隆”。预检回答 Lore 将如何克隆
 * （共享数据块、复制字节或不支持），确认弹窗展示这一方式；真实克隆会持有源 Instance 与
 * Store 的锁直到完成，由父组件经 Repository 写队列执行。
 */
export function InstanceClonePanel({
  repositoryName,
  busy = false,
  onSelectParent,
  onPreview,
  onClone,
  onCloned
}: InstanceClonePanelProps) {
  const { t } = useTranslation()
  const [parentDirectory, setParentDirectory] = useState('')
  const [directoryName, setDirectoryName] = useState('')
  const [allowCopy, setAllowCopy] = useState(false)
  const [preview, setPreview] = useState<{ request: InstanceCloneRequest; value: LoreInstanceClonePreview } | null>(
    null
  )
  const [result, setResult] = useState<LoreInstanceCloneResult | null>(null)
  const [pending, setPending] = useState<'' | 'select' | 'preview' | 'clone'>('')
  const [error, setError] = useState('')

  const request: InstanceCloneRequest = { parentDirectory, directoryName, allowCopy }
  const complete = parentDirectory.trim() !== '' && directoryName.trim() !== ''
  const locked = busy || pending !== ''
  // 输入一变化，之前的预检与结果就不再描述当前表单。
  const currentPreview = preview && sameRequest(preview.request, request) ? preview.value : null

  const edit = (change: () => void) => {
    change()
    setResult(null)
    setError('')
  }

  const chooseParent = async () => {
    try {
      setPending('select')
      const selected = await onSelectParent()
      if (selected) edit(() => setParentDirectory(selected))
    } catch (selectError) {
      setError(readPanelError(selectError))
    } finally {
      setPending('')
    }
  }

  const runPreview = async (): Promise<LoreInstanceClonePreview | null> => {
    try {
      setPending('preview')
      setError('')
      setResult(null)
      const value = await onPreview(request)
      setPreview({ request, value })
      return value
    } catch (previewError) {
      setPreview(null)
      setError(readPanelError(previewError))
      return null
    } finally {
      setPending('')
    }
  }

  const startClone = async () => {
    // 直接点“克隆”时先补一次预检：确认弹窗必须展示 Lore 实际选择的方式。
    const value = currentPreview ?? (await runPreview())
    if (!value || value.refusal) return
    if (
      !confirmLocalized(
        t('confirm.cloneInstance', {
          repository: repositoryName,
          target: value.targetPath,
          method: t(methodLabelKey(value.plan.method))
        })
      )
    ) {
      return
    }
    try {
      setPending('clone')
      setError('')
      setResult(null)
      setResult(await onClone(request))
      onCloned?.()
    } catch (cloneError) {
      setError(readPanelError(cloneError))
    } finally {
      setPending('')
    }
  }

  return (
    <section className="diagnostic-module diagnostic-module--wide diagnostic-module--instance-clone">
      <header>
        <span className="diagnostic-module__icon">
          <CopyPlus size={15} />
        </span>
        <h3>{t('cloneInstance')}</h3>
      </header>
      <div className="instance-clone__body">
        <p className="instance-clone__hint">{t('cloneInstanceDescription')}</p>
        <div className="diagnostic-module__fields diagnostic-module__fields--split instance-clone__fields">
          <label className="tool-field">
            <span>{t('instanceCloneParentDirectory')}</span>
            <span className="instance-clone__path">
              <TextInput
                value={parentDirectory}
                spellCheck={false}
                onChange={(event) => edit(() => setParentDirectory(event.target.value))}
              />
              <TextButton disabled={locked} onClick={() => void chooseParent()}>
                {pending === 'select' ? <LoaderCircle className="is-spinning" size={14} /> : <FolderOpen size={14} />}
                {t('choose')}
              </TextButton>
            </span>
          </label>
          <label className="tool-field">
            <span>{t('instanceCloneDirectoryName')}</span>
            <TextInput
              value={directoryName}
              spellCheck={false}
              onChange={(event) => edit(() => setDirectoryName(event.target.value))}
            />
          </label>
        </div>
        <label className="instance-clone__check">
          <CheckboxInput checked={allowCopy} onChange={(event) => edit(() => setAllowCopy(event.target.checked))} />
          <span>{t('instanceCloneAllowCopy')}</span>
        </label>
        <small className="instance-clone__hint">{t('instanceCloneAllowCopyHint')}</small>
        <small className="instance-clone__hint">{t('instanceCloneSharedStoreOnly')}</small>
        {error && <div className="tool-inline-error">{error}</div>}
        {currentPreview && <InstanceClonePlanView preview={currentPreview} allowCopy={allowCopy} />}
        {result && (
          <div className="instance-clone__result" role="status">
            {t('status.instanceCloneResult', {
              id: result.instanceId.slice(0, 8) || '—',
              path: result.targetPath,
              directories: result.clonedDirectoryCount,
              entries: result.clonedEntryCount,
              copied: result.copiedFileCount
            })}
          </div>
        )}
      </div>
      <footer className="tool-action-row">
        <TextButton disabled={locked || !complete} onClick={() => void runPreview()}>
          {pending === 'preview' ? <LoaderCircle className="is-spinning" size={14} /> : <ScanSearch size={14} />}
          {t('previewInstanceClone')}
        </TextButton>
        <TextButton variant="primary" disabled={locked || !complete} onClick={() => void startClone()}>
          {pending === 'clone' ? <LoaderCircle className="is-spinning" size={14} /> : <CopyPlus size={14} />}
          {t('startInstanceClone')}
        </TextButton>
      </footer>
    </section>
  )
}

/** 预检结果：Lore 在写入任何内容之前决定的克隆方式，以及被拒绝时的原因。 */
function InstanceClonePlanView({ preview, allowCopy }: { preview: LoreInstanceClonePreview; allowCopy: boolean }) {
  const { t } = useTranslation()
  const { plan, refusal } = preview

  let summary: string
  if (refusal === null) {
    summary = plan.method === 'sharesBlocks' ? t('instanceCloneSharesBlocksSummary') : ''
  } else if (plan.method === 'copiesBytes' && refusal.status === STATUS_NOT_SUPPORTED && !allowCopy) {
    summary = t('instanceCloneNeedsCopyPermission')
  } else if (plan.method === 'copiesBytes' && refusal.status === STATUS_OVERSIZED) {
    summary = t('instanceCloneInsufficientSpace')
  } else if (plan.method === 'unsupported') {
    summary = t('instanceCloneUnsupportedSummary')
  } else {
    // 其余拒绝保留 Lore 的原始说明，不猜测原因。
    summary = refusal.message
  }

  return (
    <div className={refusal ? 'instance-clone__plan is-refused' : 'instance-clone__plan'} role="status">
      <dl>
        <dt>{t('instanceCloneTarget')}</dt>
        <dd>{preview.targetPath}</dd>
        <dt>{t('instanceCloneMethod')}</dt>
        <dd>{t(methodLabelKey(plan.method))}</dd>
        {plan.filesystem && (
          <>
            <dt>{t('instanceCloneVolume')}</dt>
            <dd>{plan.mountPoint ? `${plan.filesystem} · ${plan.mountPoint}` : plan.filesystem}</dd>
          </>
        )}
        {plan.method === 'copiesBytes' && (
          <>
            <dt>{t('instanceCloneNeedsToWrite')}</dt>
            <dd>{t('status.instanceCloneCopySummary', { count: plan.fileCount, size: formatBytes(plan.size) })}</dd>
            <dt>{t('instanceCloneAvailableSpace')}</dt>
            <dd>{formatBytes(plan.availableSize)}</dd>
          </>
        )}
        {plan.reason && (
          <>
            <dt>{t('instanceCloneReason')}</dt>
            <dd>{plan.reason}</dd>
          </>
        )}
      </dl>
      {summary && <p>{summary}</p>}
    </div>
  )
}

function readPanelError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error && 'message' in error) return String(error.message)
  return String(error)
}
