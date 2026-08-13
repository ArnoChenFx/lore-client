import { GitBranch, GitCommitHorizontal, LoaderCircle, Save, Tags, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { t } from '../../../i18n'
import type { LoreTag, TagCreationSource } from '../../../types'

interface TagDialogProps {
  busy: boolean
  source: TagCreationSource
  tag?: LoreTag | null
  onSubmit: (name: string, message: string) => void
  onClose: () => void
}

/**
 * 创建与编辑共用同一弹层。
 *
 * 编辑时 Branch 与 Revision 只读，防止“修改说明”暗中移动标签；需要移动指针时，
 * 用户应从新的 Branch 或 Revision 创建另一个标签，并显式删除旧标签。
 */
export function TagDialog({ busy, source, tag, onSubmit, onClose }: TagDialogProps) {
  const { t } = useTranslation()
  const editing = Boolean(tag)
  const [name, setName] = useState(tag?.name ?? '')
  const [message, setMessage] = useState(tag?.message ?? '')

  // 切换编辑对象时重置草稿；渲染期跟随（官方 adjusting state during render 模式），
  // 避免 effect 同步 setState（react-compiler EffectSetState）。key 使用内容签名，
  // 不依赖父级对 tag 对象引用的稳定性，用户输入过程中不会触碰草稿。
  const tagKey = tag ? `${tag.name}|${tag.message}` : ''
  const [lastTagKey, setLastTagKey] = useState(tagKey)
  if (lastTagKey !== tagKey) {
    setLastTagKey(tagKey)
    setName(tag?.name ?? '')
    setMessage(tag?.message ?? '')
  }

  const sourceDescription =
    source.kind === 'revision'
      ? t('selectedHistoricalRevision')
      : source.kind === 'branch'
        ? t('selectedBranchRevision')
        : t('currentWorkspaceRevision')

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <form
        className="task-dialog tag-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (name.trim()) onSubmit(name.trim(), message.trim())
        }}
      >
        <header className="task-dialog__header">
          <span className="task-dialog__mark">
            <Tags size={18} />
          </span>
          <span>
            <small>{t('repositorySharedMetadata')}</small>
            <h2>{editing ? t('editTag') : t('newTag')}</h2>
          </span>
          <button type="button" aria-label={t('close')} onClick={onClose} disabled={busy}>
            <X size={16} />
          </button>
        </header>

        <div className="task-dialog__body">
          <section className="tag-source" aria-label={t('tagTarget')}>
            <span className="tag-source__mark">
              <Tags size={16} />
            </span>
            <span>
              <small>{t('targetBranch')}</small>
              <strong>
                <GitBranch size={12} />
                {source.branch}
              </strong>
              <em>{editing ? t('editingMoveTagTargetRevision_ff41') : sourceDescription}</em>
            </span>
            <span>
              <small>{t('targetRevision')}</small>
              <code>
                <GitCommitHorizontal size={12} />
                {source.revision.slice(0, 8)}
              </code>
            </span>
          </section>

          <label className="field-stack">
            <span>{t('tagName')}</span>
            <input
              autoFocus
              value={name}
              maxLength={128}
              onChange={(event) => setName(event.target.value)}
              placeholder="release/meridian-1.0"
              required
            />
            <small>{t('supportsChineseCharactersSlashesDots_a63d')}</small>
          </label>

          <label className="field-stack">
            <span>{t('description')}</span>
            <textarea
              value={message}
              maxLength={4096}
              onChange={(event) => setMessage(event.target.value)}
              placeholder={t('describeReleaseScopeReviewConclusion_a6b3')}
              rows={5}
            />
          </label>

          <aside className="tag-dialog__persistence">
            <span>
              <Tags size={14} />
            </span>
            <span>
              <strong>{t('writeLoreRepositorySharedMetadata')}</strong>
              <small>{t('operationRequiresOnlineServerOther_2a36')}</small>
            </span>
          </aside>
        </div>

        <footer className="task-dialog__footer">
          <button type="button" onClick={onClose} disabled={busy}>
            {t('cancel')}
          </button>
          <button className="is-primary" type="submit" disabled={busy || !name.trim()}>
            {busy ? <LoaderCircle className="is-spinning" size={14} /> : <Save size={14} />}
            {editing ? t('saveChanges') : t('createTag')}
          </button>
        </footer>
      </form>
    </div>
  )
}
