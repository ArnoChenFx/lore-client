import { AudioLines } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface AudioPreviewProps {
  fileName: string
  label: string
  mimeType: string
  dataBase64: string
}

/**
 * 使用 WebView 媒体管线播放受控音频字节。
 *
 * 控件永不自动播放，也不创建远端 URL；源地址只由 Rust 白名单 MIME 与本次 IPC
 * Base64 构造。浏览器无法解码某个合法编码时，会显示原生不可播放状态而非伪造成功。
 */
export function AudioPreview({ fileName, label, mimeType, dataBase64 }: AudioPreviewProps) {
  const { t } = useTranslation()
  return (
    <div className="binary-diff-preview__audio-viewer" aria-label={t('status.audioPreview', { fileName, label })}>
      <div className="binary-diff-preview__audio-heading">
        <AudioLines size={26} />
        <div>
          <strong>{fileName}</strong>
          <span>{mimeType}</span>
        </div>
      </div>
      <audio controls preload="metadata" src={`data:${mimeType};base64,${dataBase64}`}>
        {t('audioPlaybackUnsupported')}
      </audio>
    </div>
  )
}
