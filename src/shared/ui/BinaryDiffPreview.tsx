import { ArrowRight, Binary, FileWarning, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { BinaryDiffPreview, BinaryFilePreview } from '../../types'
import { formatPreviewBytes } from '../lib'
import { AudioPreview } from './AudioPreview'
import { CsvTablePreview } from './CsvTablePreview'
import { FontPreview } from './FontPreview'
import { ModelCanvasPreview } from './ModelCanvasPreview'
import { PdfCanvasPreview } from './PdfCanvasPreview'
import { StructuredAssetPreview } from './StructuredAssetPreview'
import { TextureCanvasPreview } from './TextureCanvasPreview'

interface BinaryDiffPreviewProps {
  fileName: string
  preview: BinaryDiffPreview | null
  loading: boolean
  error: string | null
  /** 原始文件字节数；预览不可用时用于显示基础文件信息。 */
  size?: number
}

interface PreviewCardProps {
  label: string
  fileName: string
  preview: BinaryFilePreview
}

/**
 * 将 Raw IPC 字节转换为 Object URL。
 *
 * Object URL 比 data URL 更高效：
 * 浏览器可以直接访问内存中的 Blob，释放时再显式调用 URL.revokeObjectURL。
 * SSR 不生成内嵌 data URL，避免测试或预渲染重新引入大字符串路径。
 */
function useObjectUrl(data: Uint8Array, mimeType: string): string {
  const [url, setUrl] = useState('')

  useEffect(() => {
    if (data.byteLength === 0) {
      setUrl('')
      return
    }

    // 浏览器环境中使用 Object URL。
    if (typeof URL.createObjectURL !== 'undefined') {
      try {
        const blob = new Blob([data.slice().buffer], { type: mimeType })
        const objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)

        // 组件卸载时释放 Object URL。
        return () => {
          URL.revokeObjectURL(objectUrl)
        }
      } catch {
        setUrl('')
      }
    }
  }, [data, mimeType])

  return url
}

/**
 * 使用 Object URL 渲染图片预览。
 *
 * Object URL 不把原始字节嵌入 HTML，且卸载时可以显式释放。
 */
function ImagePreview({
  fileName,
  label,
  data,
  mimeType
}: {
  fileName: string
  label: string
  data: Uint8Array
  mimeType: string
}) {
  const url = useObjectUrl(data, mimeType)

  if (!url) {
    return null
  }

  return <img src={url} alt={`${fileName}（${label}）`} draggable={false} />
}

/**
 * 渲染一个已经通过 Rust 白名单校验的预览版本。
 *
 * 图片使用 Object URL 以减少内存占用；PDF、三维模型与 CSV 都在应用内解析，
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
          <ImagePreview fileName={fileName} label={label} data={preview.data} mimeType={preview.mimeType} />
        ) : preview.kind === 'texture' ? (
          <TextureCanvasPreview
            fileName={fileName}
            label={label}
            data={preview.data}
            metadata={preview.structuredPreview}
          />
        ) : preview.kind === 'model' ? (
          <ModelCanvasPreview fileName={fileName} label={label} data={preview.data} />
        ) : preview.kind === 'csv' ? (
          <CsvTablePreview fileName={fileName} label={label} data={preview.data} />
        ) : preview.kind === 'audio' ? (
          <AudioPreview fileName={fileName} label={label} mimeType={preview.mimeType} data={preview.data} />
        ) : preview.kind === 'font' ? (
          <FontPreview fileName={fileName} label={label} data={preview.data} />
        ) : preview.kind === 'archive' || preview.kind === 'asset' ? (
          <StructuredAssetPreview
            fileName={fileName}
            label={label}
            preview={preview.structuredPreview}
            size={preview.size}
          />
        ) : (
          <PdfCanvasPreview fileName={fileName} label={label} data={preview.data} />
        )}
      </div>
    </article>
  )
}

/** 为大小变化补充明确正负号；零值保持中性，避免出现“+0 B”。 */
function formatSizeDelta(bytes: number): string {
  if (bytes === 0) return formatPreviewBytes(0)
  return `${bytes > 0 ? '+' : '−'}${formatPreviewBytes(Math.abs(bytes))}`
}

/**
 * 元数据降级不读取正文，只使用 Rust 在读取前取得的可信文件大小展示变化。
 *
 * 新增或删除文件天然缺少一侧，以长横线保留同一列位；变化量按空文件计算，仍能
 * 直观看出这次 Revision 或工作区更改增加、减少了多少磁盘内容。
 */
function SizeOnlyPreview({
  preview,
  reason
}: {
  preview: BinaryDiffPreview
  reason: 'tooLarge' | 'unsupported' | 'metadataOnly'
}) {
  const { t } = useTranslation()
  const beforeSize = preview.before?.size
  const afterSize = preview.after?.size
  const delta = (afterSize ?? 0) - (beforeSize ?? 0)
  const deltaTone = delta > 0 ? 'increase' : delta < 0 ? 'decrease' : 'unchanged'
  const titleKey =
    reason === 'tooLarge'
      ? 'binaryPreviewSizeOnly'
      : reason === 'unsupported'
        ? 'binaryPreviewUnsupportedSizeOnly'
        : 'binaryDiffHidden'
  const hintKey =
    reason === 'tooLarge'
      ? 'binaryPreviewSizeOnlyHint'
      : reason === 'unsupported'
        ? 'binaryPreviewUnsupportedSizeOnlyHint'
        : 'binaryPreviewMetadataOnlyHint'

  return (
    <div className="binary-diff-preview__size-only" role="status">
      {reason === 'tooLarge' ? <FileWarning size={30} /> : <Binary size={30} />}
      <strong>{t(titleKey)}</strong>
      <span>{t(hintKey)}</span>
      <div className="binary-diff-preview__size-comparison">
        <div>
          <small>{t('before')}</small>
          <b>{beforeSize === undefined ? '—' : formatPreviewBytes(beforeSize)}</b>
        </div>
        <ArrowRight size={18} aria-hidden="true" />
        <div>
          <small>{t('after')}</small>
          <b>{afterSize === undefined ? '—' : formatPreviewBytes(afterSize)}</b>
        </div>
        <div className={`binary-diff-preview__size-delta is-${deltaTone}`}>
          <small>{t('fileSizeChange')}</small>
          <b>{formatSizeDelta(delta)}</b>
        </div>
      </div>
    </div>
  )
}

/** 所有受控资产类型共用的 Diff 预览表面；两侧缺失时给出明确状态。 */
export function BinaryDiffPreview({ fileName, preview, loading, error, size }: BinaryDiffPreviewProps) {
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

  const metadataOnlyReason =
    preview?.before?.contentState === 'tooLarge' || preview?.after?.contentState === 'tooLarge'
      ? 'tooLarge'
      : preview?.before?.contentState === 'unsupported' || preview?.after?.contentState === 'unsupported'
        ? 'unsupported'
        : preview?.before?.contentState === 'metadataOnly' || preview?.after?.contentState === 'metadataOnly'
          ? 'metadataOnly'
          : null
  if (metadataOnlyReason && preview) {
    return <SizeOnlyPreview preview={preview} reason={metadataOnlyReason} />
  }

  if (!preview?.before && !preview?.after) {
    return (
      <div className="binary-diff-preview__empty">
        <Binary size={30} />
        <strong>{t('noPreviewVersionToDisplay')}</strong>
        <span>{fileName}</span>
        {size !== undefined && <span>{formatPreviewBytes(size)}</span>}
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
