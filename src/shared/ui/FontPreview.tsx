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
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    let cancelled = false
    let loadedFace: FontFace | null = null
    setStatus('loading')

    void (async () => {
      try {
        // FontFace 可能接管传入缓冲；只复制一次，不能转移 React state 持有的 Raw IPC 数据。
        const copy = readBinaryPreviewData(data).slice()
        const face = new FontFace(family, copy.buffer)
        loadedFace = await face.load()
        if (cancelled) return
        document.fonts.add(loadedFace)
        setStatus('ready')
      } catch {
        if (!cancelled) setStatus('error')
      }
    })()

    return () => {
      cancelled = true
      if (loadedFace) document.fonts.delete(loadedFace)
    }
  }, [data, family])

  if (status === 'loading') return null

  if (status === 'error') {
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
