import { useCallback, useEffect, useRef, useState } from 'react'

import { t } from '../i18n'
import { getLoreRuntimeInfo } from '../services/lore'
import { readErrorMessage } from '../shared/lib'
import type { LoreRuntimeInfo, ToastMessage } from '../types'
import type { AppUpdateState } from './appUpdater'

interface UseAppFeedbackOptions {
  updateState: AppUpdateState
  preferencesError: string | null
  showUpdate: () => void
}

/**
 * 集中管理应用级反馈生命周期。
 *
 * Toast、Lore 运行时信息、更新发现与偏好保存错误只影响窗口外壳，不属于任何仓库
 * 领域。所有文案都在通知发生时翻译，语言切换后不会复用旧语言字符串。
 */
export function useAppFeedback({ updateState, preferencesError, showUpdate }: UseAppFeedbackOptions) {
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const [runtimeInfo, setRuntimeInfo] = useState<LoreRuntimeInfo | null>(null)
  const toastCounter = useRef(0)
  const notifiedUpdateVersion = useRef('')

  const notify = useCallback((title: string, detail: string, tone: ToastMessage['tone'] = 'info') => {
    toastCounter.current += 1
    setToast({ id: toastCounter.current, title, detail, tone })
  }, [])

  const closeToast = useCallback(() => setToast(null), [])

  useEffect(() => {
    void getLoreRuntimeInfo()
      .then(setRuntimeInfo)
      .catch((error) => notify(t('loreCoreInitializationFailed'), readErrorMessage(error), 'warning'))
  }, [notify])

  useEffect(() => {
    const { phase, currentVersion, availableVersion } = updateState
    if (phase !== 'available' || !availableVersion || notifiedUpdateVersion.current === availableVersion) return
    notifiedUpdateVersion.current = availableVersion
    notify(
      t('applicationUpdateAvailable'),
      t('status.updateVersionAvailable', {
        current: currentVersion || '—',
        available: availableVersion
      }),
      'info'
    )
    // 手动检查与启动检查统一进入安装确认面板，真正写入前仍要求用户明确确认。
    showUpdate()
  }, [notify, showUpdate, updateState])

  useEffect(() => {
    if (preferencesError) {
      notify(t('failedToSaveClientPreferences'), preferencesError, 'warning')
    }
  }, [notify, preferencesError])

  useEffect(() => {
    if (!toast) return
    /*
     * 失败详情通常包含服务端错误码和上下文，给用户足够时间阅读或复制；成功反馈
     * 仍保持短暂，避免高频操作长期占据工作区。
     */
    const timeout = window.setTimeout(closeToast, toast.tone === 'warning' ? 12_000 : 3_600)
    return () => window.clearTimeout(timeout)
  }, [closeToast, toast])

  return {
    toast,
    runtimeInfo,
    notify,
    closeToast
  }
}
