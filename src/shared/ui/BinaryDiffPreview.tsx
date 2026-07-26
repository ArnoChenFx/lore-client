import { Binary, FileWarning, LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { t } from '../../i18n'
import type { BinaryDiffPreview, BinaryFilePreview } from '../../types'
import { formatPreviewBytes } from '../lib'
import { CsvTablePreview } from './CsvTablePreview'
import { ModelCanvasPreview } from './ModelCanvasPreview'
import { PdfCanvasPreview } from './PdfCanvasPreview'

interface BinaryDiffPreviewProps {
  fileName: string
  preview: BinaryDiffPreview | null
  loading: boolean
  error: string | null
}

interface PreviewCardProps {
  label: string
  fileName: string
  preview: BinaryFilePreview
}

/**
 * 渲染一个已经通过 Rust 白名单校验的预览版本。
 *
 * 图片可直接用受控 MIME 的 data URL；PDF、三维模型与 CSV 都在应用内解析，
 * 不依赖 WebView2 原生插件，也不创建可执行链接、表单或脚本层。
 */
function PreviewCard({ label, fileName, preview }: PreviewCardProps) {
  return (
    <article className={`binary-diff-preview__card is-${preview.kind}`}>
      <header>
        <strong>{label}</strong>
        <small>{formatPreviewBytes(preview.size)}</small>
      </header>
      <div className="binary-diff-preview__canvas">
        {preview.kind === 'image' ? (
          <img
            src={`data:${preview.mimeType};base64,${preview.dataBase64}`}
            alt={`${fileName}（${label}）`}
            draggable={false}
          />
        ) : preview.kind === 'model' ? (
          <ModelCanvasPreview fileName={fileName} label={label} dataBase64={preview.dataBase64} />
        ) : preview.kind === 'csv' ? (
          <CsvTablePreview fileName={fileName} label={label} dataBase64={preview.dataBase64} />
        ) : (
          <PdfCanvasPreview fileName={fileName} label={label} dataBase64={preview.dataBase64} />
        )}
      </div>
    </article>
  )
}

/** 图片、PDF、三维模型与 CSV 共用的 Diff 预览表面；两侧缺失时给出明确状态。 */
export function BinaryDiffPreview({ fileName, preview, loading, error }: BinaryDiffPreviewProps) {
  const { t } = useTranslation()
  if (loading) {
    return (
      <div className="binary-diff-preview__empty" role="status">
        <LoaderCircle className="is-spinning" size={28} />
        <strong>{t('loadingPreview')}</strong>
        <span>{fileName}</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="binary-diff-preview__empty is-error" role="alert">
        <FileWarning size={30} />
        <strong>{t('unableToDisplayPreview')}</strong>
        <span>{error}</span>
      </div>
    )
  }

  if (!preview?.before && !preview?.after) {
    return (
      <div className="binary-diff-preview__empty">
        <Binary size={30} />
        <strong>{t('noPreviewVersionToDisplay')}</strong>
        <span>{fileName}</span>
      </div>
    )
  }

  return (
    <div className={`binary-diff-preview ${preview.before && preview.after ? 'has-comparison' : ''}`}>
      {preview.before && <PreviewCard label={t('before')} fileName={fileName} preview={preview.before} />}
      {preview.after && <PreviewCard label={t('after')} fileName={fileName} preview={preview.after} />}
    </div>
  )
}
