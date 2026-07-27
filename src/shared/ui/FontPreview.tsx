import { FileWarning, LoaderCircle, Type } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { decodeBinaryPreviewBase64 } from '../lib'

interface FontPreviewProps {
  fileName: string
  label: string
  dataBase64: string
}

/**
 * 从内存字节创建仅在组件生命周期内存在的字体。
 *
 * FontFace 不接收 URL，因此字体无法追随外部资源；卸载时从 document.fonts 删除，
 * 避免多次切换前后版本后积累不可回收的临时字体族。
 */
export function FontPreview({ fileName, label, dataBase64 }: FontPreviewProps) {
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
        const bytes = decodeBinaryPreviewBase64(dataBase64)
        const copy = new Uint8Array(bytes.byteLength)
        copy.set(bytes)
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
  }, [dataBase64, family])

  if (status !== 'ready') {
    return (
      <div className={`binary-diff-preview__pdf-status ${status === 'error' ? 'is-error' : ''}`} role="status">
        {status === 'error' ? <FileWarning size={24} /> : <LoaderCircle className="is-spinning" size={24} />}
        <span>{status === 'error' ? t('fontPreviewLoadFailed') : t('loadingFontPreview')}</span>
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
