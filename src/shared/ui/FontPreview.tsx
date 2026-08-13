import { FileWarning, Type } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { readBinaryPreviewData, type BinaryPreviewData } from './binaryPreviewData'

interface FontPreviewProps {
  fileName: string
  label: string
  data: BinaryPreviewData
}

/**
 * 从内存字节创建仅在组件生命周期内存在的字体。
 *
 * FontFace 不接收 URL，因此字体无法追随外部资源；卸载时从 document.fonts 删除，
 * 避免多次切换前后版本后积累不可回收的临时字体族。
 */
export function FontPreview({ fileName, label, data }: FontPreviewProps) {
  const { t } = useTranslation()
  const instanceId = useId().replaceAll(':', '')
  const family = `LoreAssetPreview-${instanceId}`
  // 加载结果与来源 data 绑定：data 切换后旧结果由渲染期过滤，避免在 effect 同步体
  // 内重置状态（react-compiler EffectSetState 会把它判为级联渲染）。
  const [status, setStatus] = useState<{ source: BinaryPreviewData; value: 'loading' | 'ready' | 'error' } | null>(null)

  useEffect(() => {
    let cancelled = false
    let loadedFace: FontFace | null = null

    void (async () => {
      try {
        // FontFace 可能接管传入缓冲；只复制一次，不能转移 React state 持有的 Raw IPC 数据。
        const copy = readBinaryPreviewData(data).slice()
        const face = new FontFace(family, copy.buffer)
        loadedFace = await face.load()
        if (cancelled) return
        document.fonts.add(loadedFace)
        setStatus({ source: data, value: 'ready' })
      } catch {
        if (!cancelled) setStatus({ source: data, value: 'error' })
      }
    })()

    return () => {
      cancelled = true
      if (loadedFace) document.fonts.delete(loadedFace)
    }
  }, [data, family])

  // 只消费当前 data 的加载结果；data 切换后立即回到 loading，无需 effect 重置。
  const currentStatus = status?.source === data ? status.value : 'loading'

  if (currentStatus === 'loading') return null

  if (currentStatus === 'error') {
    return (
      <div className="binary-diff-preview__pdf-status is-error" role="alert">
        <FileWarning size={24} />
        <span>{t('fontPreviewLoadFailed')}</span>
      </div>
    )
  }

  return (
    <div className="binary-diff-preview__font-viewer" aria-label={t('status.fontPreview', { fileName, label })}>
      <header>
        <Type size={18} />
        <span>{fileName}</span>
      </header>
      <div style={{ fontFamily: `'${family}'` }}>
        <strong>{t('fontPreviewSample')}</strong>
        <p>{t('fontPreviewAlphabet')}</p>
        <p>0123456789 · !?@#$%&amp;*()</p>
      </div>
    </div>
  )
}
