import { Check, Copy, LoaderCircle, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { TextButton } from '../../../shared/ui'
import type { AuthUrlPromptState } from '../authUrlPrompt'

interface AuthUrlDialogProps {
  prompt: AuthUrlPromptState
  onDismiss: () => void
}

/**
 * 展示 OIDC 设备授权流的确认代码。
 *
 * Lore 已在浏览器中打开登录页，页面可能要求核对或输入这组代码（RFC 8628
 * §3.3.1）：代码与页面一致才表示登录的是用户自己的会话。本对话框只负责把
 * 代码送到用户眼前，登录的等待与结果仍由发起入口的原有状态负责；登录结束
 * 时 Rust 会发 dismiss 信号自动收起，用户也可手动关闭。
 */
export function AuthUrlDialog({ prompt, onDismiss }: AuthUrlDialogProps) {
  const { t } = useTranslation()
  // 复制反馈按 operationId 派生：换一次登录自动复位，不把上一次的“已复制”带过来。
  const [copiedOperationId, setCopiedOperationId] = useState<string | null>(null)
  const copied = copiedOperationId === prompt.operationId

  useEffect(() => {
    if (!copied) return undefined
    const timer = setTimeout(() => setCopiedOperationId(null), 1_600)
    return () => clearTimeout(timer)
  }, [copied])

  const copyUserCode = () => {
    // 剪贴板不可用（权限/演示环境）时静默失败：代码本身就在眼前，可手动抄录。
    void navigator.clipboard?.writeText(prompt.userCode).then(
      () => setCopiedOperationId(prompt.operationId),
      () => undefined
    )
  }

  return (
    <div className="dialog-backdrop auth-url-backdrop" role="presentation">
      <section
        className="task-dialog compact-dialog auth-url-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-url-title"
        aria-describedby="auth-url-description"
      >
        <header className="task-dialog__header">
          <span className="task-dialog__mark">
            <ShieldCheck size={18} />
          </span>
          <span>
            <small>{t('remoteAccess')}</small>
            <h2 id="auth-url-title">{t('authUrlConfirmationTitle')}</h2>
          </span>
        </header>
        <div className="task-dialog__body auth-url-dialog__body">
          <p id="auth-url-description">{t('authUrlConfirmationDescription')}</p>
          {prompt.userCode && (
            <div className="auth-url-dialog__code-row">
              <code className="auth-url-dialog__code" aria-label={t('authConfirmationCode')}>
                {prompt.userCode}
              </code>
              <TextButton onClick={copyUserCode}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? t('userCodeCopied') : t('copyUserCode')}
              </TextButton>
            </div>
          )}
          <dl>
            <div>
              <dt>{t('authLoginPage')}</dt>
              <dd>{prompt.url}</dd>
            </div>
          </dl>
          <p className="auth-url-dialog__waiting-hint">
            <LoaderCircle className="is-spinning" size={15} />
            <span>{t('authUrlWaitingHint')}</span>
          </p>
        </div>
        <footer className="task-dialog__footer">
          <TextButton onClick={onDismiss}>{t('close')}</TextButton>
        </footer>
      </section>
    </div>
  )
}
