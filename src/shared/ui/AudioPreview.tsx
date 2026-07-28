import { AudioLines } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

interface AudioPreviewProps {
  fileName: string
  label: string
  mimeType: string
  data: Uint8Array
}

/**
 * 使用 WebView 媒体管线播放受控音频字节。
 *
 * 控件永不自动播放，也不创建远端 URL；源地址只由 Rust 白名单 MIME 与本次 Raw IPC
 * 字节构造。浏览器无法解码某个合法编码时，会显示原生不可播放状态而非伪造成功。
 */
export function AudioPreview({ fileName, label, mimeType, data }: AudioPreviewProps) {
  const { t } = useTranslation()
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    let objectUrl = ''
    if (typeof URL.createObjectURL === 'function') {
      objectUrl = URL.createObjectURL(new Blob([data.slice().buffer], { type: mimeType }))
      audio.src = objectUrl
    } else {
      audio.removeAttribute('src')
    }
    audio.load()

    return () => {
      /*
       * 仅移除 React 的 src 属性不足以要求 WebView 媒体管线释放解码缓存；按 HTML
       * 媒体元素生命周期先停止播放、移除资源并重新 load，再撤销 Blob URL。
       */
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [data, mimeType])

  return (
    <div className="binary-diff-preview__audio-viewer" aria-label={t('status.audioPreview', { fileName, label })}>
      <div className="binary-diff-preview__audio-heading">
        <AudioLines size={26} />
        <div>
          <strong>{fileName}</strong>
          <span>{mimeType}</span>
        </div>
      </div>
      <audio ref={audioRef} controls preload="metadata">
        {t('audioPlaybackUnsupported')}
      </audio>
    </div>
  )
}
