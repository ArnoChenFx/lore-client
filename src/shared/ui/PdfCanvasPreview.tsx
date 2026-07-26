import { ChevronLeft, ChevronRight, FileWarning, LoaderCircle } from 'lucide-react'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { t } from '../../i18n'
import { decodeBinaryPreviewBase64 } from '../lib'
import { IconButton } from './IconButton'

interface PdfCanvasPreviewProps {
  fileName: string
  label: string
  dataBase64: string
}

/**
 * 把 IPC 返回的 Base64 内容还原为 PDF.js 可接管所有权的独立字节数组。
 *
 * 这里不生成 data URL 或 Blob URL：两种 URL 最终仍可能交给 WebView2 的内置
 * PDF 查看器，而该查看器在 iframe 场景存在拦截与兼容性问题。
 */
export function decodePdfBase64(dataBase64: string): Uint8Array {
  return decodeBinaryPreviewBase64(dataBase64)
}

/** 将 PDF.js 的内部异常收敛成稳定、可操作的中文提示。 */
function describePdfError(error: unknown): string {
  const errorName = error instanceof Error ? error.name : ''
  if (errorName === 'PasswordException') {
    return t('pdfPasswordProtectedInlinePreview_0be1')
  }
  if (errorName === 'InvalidPDFException') {
    return t('pdfContentInvalidCorruptedPreview_90bc')
  }
  return t('failedParseRenderPdfConfirm_4a0b')
}

/**
 * 使用 PDF.js 将单页绘制到 Canvas。
 *
 * 组件只渲染当前页，并在尺寸变化时取消旧任务后重绘，避免长文档一次性占用大量
 * 内存；同时不创建注释层，因此 PDF 内的链接、表单和脚本不会进入应用交互上下文。
 */
export function PdfCanvasPreview({ fileName, label, dataBase64 }: PdfCanvasPreviewProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const renderTaskRef = useRef<RenderTask | null>(null)
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null)
  const [pageNumber, setPageNumber] = useState(1)
  const [pageCount, setPageCount] = useState(0)
  const [surfaceWidth, setSurfaceWidth] = useState(0)
  const [loadingDocument, setLoadingDocument] = useState(true)
  const [renderingPage, setRenderingPage] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return

    /** 只在有效宽度发生变化时触发重绘，降低拖动 Inspector 分割线时的任务抖动。 */
    const updateWidth = (width: number) => {
      const nextWidth = Math.max(0, Math.round(width))
      setSurfaceWidth((currentWidth) => (currentWidth === nextWidth ? currentWidth : nextWidth))
    }

    updateWidth(surface.getBoundingClientRect().width)
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) updateWidth(entry.contentRect.width)
    })
    observer.observe(surface)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    let loadingTask: PDFDocumentLoadingTask | null = null

    setPdfDocument(null)
    setPageNumber(1)
    setPageCount(0)
    setLoadingDocument(true)
    setError(null)

    void (async () => {
      try {
        // 核心解析器与 worker 均按需加载，图片预览不会承担 PDF.js 的启动成本。
        const [pdfjs, { default: pdfWorkerUrl }] = await Promise.all([
          import('pdfjs-dist'),
          import('pdfjs-dist/build/pdf.worker.min.mjs?url')
        ])
        if (cancelled) return

        // Vite 会把 worker 作为独立静态资源打包，避免依赖 WebView2 原生 PDF 插件。
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
        loadingTask = pdfjs.getDocument({
          data: decodePdfBase64(dataBase64),
          stopAtErrors: true,
          useWorkerFetch: false
        })
        const document = await loadingTask.promise
        // 卸载路径已经通过 loadingTask.destroy() 统一释放 worker 与文档资源。
        if (cancelled) return

        setPdfDocument(document)
        setPageCount(document.numPages)
        setLoadingDocument(false)
      } catch (loadError) {
        if (cancelled) return
        setLoadingDocument(false)
        setError(describePdfError(loadError))
      }
    })()

    return () => {
      cancelled = true
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
      if (loadingTask) void loadingTask.destroy()
    }
  }, [dataBase64])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!pdfDocument || !canvas || surfaceWidth <= 0) return

    let cancelled = false
    let currentRenderTask: RenderTask | null = null
    setRenderingPage(true)
    setError(null)

    void (async () => {
      try {
        const page = await pdfDocument.getPage(pageNumber)
        if (cancelled) return

        const naturalViewport = page.getViewport({ scale: 1 })
        const availableWidth = Math.max(240, Math.min(surfaceWidth - 24, 1_200))
        const viewport = page.getViewport({ scale: availableWidth / naturalViewport.width })
        const outputScale = Math.min(window.devicePixelRatio || 1, 2)

        // CSS 尺寸控制版面，像素尺寸按设备倍率提升清晰度，并限制到 2 倍避免高 DPI 爆内存。
        canvas.width = Math.max(1, Math.floor(viewport.width * outputScale))
        canvas.height = Math.max(1, Math.floor(viewport.height * outputScale))
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`

        currentRenderTask = page.render({
          canvas,
          viewport,
          transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0]
        })
        renderTaskRef.current = currentRenderTask
        await currentRenderTask.promise
        if (!cancelled) setRenderingPage(false)
      } catch (renderError) {
        if (cancelled || (renderError instanceof Error && renderError.name === 'RenderingCancelledException')) {
          return
        }
        setRenderingPage(false)
        setError(describePdfError(renderError))
      } finally {
        if (renderTaskRef.current === currentRenderTask) renderTaskRef.current = null
      }
    })()

    return () => {
      cancelled = true
      currentRenderTask?.cancel()
      if (renderTaskRef.current === currentRenderTask) renderTaskRef.current = null
    }
  }, [pageNumber, pdfDocument, surfaceWidth])

  const busy = loadingDocument || renderingPage
  const pageLabel = pageCount > 0 ? t('status.pageOf', { page: pageNumber, total: pageCount }) : t('loadingPdf')

  return (
    <div className="binary-diff-preview__pdf-viewer">
      <div ref={surfaceRef} className="binary-diff-preview__pdf-surface" aria-busy={busy}>
        <canvas ref={canvasRef} role="img" aria-label={`${fileName}（${label}）${pageLabel}`}>
          {t('environmentSupportCanvasPdfPreview_a040')}
        </canvas>
        {busy && !error && (
          <div className="binary-diff-preview__pdf-status" role="status">
            <LoaderCircle className="is-spinning" size={24} />
            <span>{loadingDocument ? t('parsingPdf') : t('status.renderingPage', { page: pageNumber })}</span>
          </div>
        )}
        {error && (
          <div className="binary-diff-preview__pdf-status is-error" role="alert">
            <FileWarning size={24} />
            <span>{error}</span>
          </div>
        )}
      </div>
      <footer className="binary-diff-preview__pdf-toolbar">
        <IconButton
          icon={<ChevronLeft size={15} />}
          label={t('status.pdfPreviousPage', { label })}
          title={t('previousPage')}
          disabled={busy || pageNumber <= 1}
          onClick={() => setPageNumber((currentPage) => Math.max(1, currentPage - 1))}
        />
        <span>{pageLabel}</span>
        <IconButton
          icon={<ChevronRight size={15} />}
          label={t('status.pdfNextPage', { label })}
          title={t('nextPage')}
          disabled={busy || pageCount === 0 || pageNumber >= pageCount}
          onClick={() => setPageNumber((currentPage) => Math.min(pageCount, currentPage + 1))}
        />
      </footer>
    </div>
  )
}
