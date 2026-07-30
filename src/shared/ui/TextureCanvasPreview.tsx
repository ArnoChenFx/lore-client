import { FileWarning, LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Mesh, OrthographicCamera, Scene, Texture, WebGLRenderer } from 'three'

import type { StructuredAssetPreview } from '../../types'
import { readBinaryPreviewData, type BinaryPreviewData } from './binaryPreviewData'
import { disposeWebGLRenderer } from './ModelCanvasPreview'

interface TextureCanvasPreviewProps {
  fileName: string
  label: string
  data: BinaryPreviewData
  metadata?: StructuredAssetPreview | null
}

/** 把独立字节复制到可转移 ArrayBuffer，KTX2 worker 接管后不会破坏 React 状态。 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

/**
 * 使用 Three.js 自带的本地 Basis 转码器展示 KTX2。
 *
 * KTX2Loader 的 JS/WASM 通过 Vite 与应用一起打包，不配置 CDN 或远端路径；解析器只
 * 接收当前 IPC 字节。每个预览在卸载时释放 worker、纹理、材质、几何和 WebGL 上下文。
 */
export function TextureCanvasPreview({ fileName, label, data, metadata }: TextureCanvasPreviewProps) {
  const { t } = useTranslation()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    let renderer: WebGLRenderer | null = null
    let scene: Scene | null = null
    let camera: OrthographicCamera | null = null
    let mesh: Mesh | null = null
    let texture: Texture | null = null
    let resizeObserver: ResizeObserver | null = null
    let loader: { dispose: () => void } | null = null
    host.replaceChildren()
    setLoading(true)
    setError(null)

    void (async () => {
      try {
        const THREE = await import('three')
        const { KTX2Loader } = await import('three/addons/loaders/KTX2Loader.js')
        if (cancelled) return
        const canvas = document.createElement('canvas')
        canvas.setAttribute('role', 'img')
        canvas.setAttribute('aria-label', t('status.texturePreview', { fileName, label }))
        host.appendChild(canvas)
        renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'low-power' })
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
        const ktxLoader = new KTX2Loader()
        loader = ktxLoader
        ktxLoader.setWorkerLimit(1).detectSupport(renderer)
        // KTX2Loader 会接管解析缓冲；toArrayBuffer 已执行唯一一次必要复制。
        const buffer = toArrayBuffer(readBinaryPreviewData(data))
        texture = await new Promise<Texture>((resolve, reject) => ktxLoader.parse(buffer, resolve, reject))
        if (cancelled) {
          texture.dispose()
          return
        }

        scene = new THREE.Scene()
        camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
        camera.position.z = 1
        const image = texture.image as { width?: number; height?: number } | undefined
        const aspect = Math.max(0.01, (image?.width ?? 1) / Math.max(image?.height ?? 1, 1))
        const geometry = new THREE.PlaneGeometry(aspect, 1)
        const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true })
        mesh = new THREE.Mesh(geometry, material)
        scene.add(mesh)

        const render = () => {
          if (!renderer || !scene || !camera || !host) return
          const width = Math.max(1, host.clientWidth || 480)
          const height = Math.max(1, host.clientHeight || 280)
          const viewportAspect = width / height
          if (viewportAspect >= aspect) {
            camera.left = -viewportAspect / 2
            camera.right = viewportAspect / 2
            camera.top = 0.5
            camera.bottom = -0.5
          } else {
            camera.left = -aspect / 2
            camera.right = aspect / 2
            camera.top = aspect / viewportAspect / 2
            camera.bottom = -aspect / viewportAspect / 2
          }
          camera.updateProjectionMatrix()
          renderer.setSize(width, height, false)
          renderer.render(scene, camera)
        }
        render()
        resizeObserver = new ResizeObserver(render)
        resizeObserver.observe(host)
        setLoading(false)
      } catch {
        if (!cancelled) {
          setError(t('ktx2TexturePreviewFailed'))
          setLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
      resizeObserver?.disconnect()
      if (mesh) {
        const disposable = mesh as Mesh & {
          geometry: { dispose: () => void }
          material: { dispose: () => void }
        }
        disposable.geometry.dispose()
        disposable.material.dispose()
      }
      texture?.dispose()
      loader?.dispose()
      if (renderer) disposeWebGLRenderer(renderer)
      host.replaceChildren()
    }
  }, [data, fileName, label, t])

  const facts = metadata?.type === 'assetMetadata' ? metadata.facts : []
  const width = facts.find((fact) => fact.key === 'width')?.value
  const height = facts.find((fact) => fact.key === 'height')?.value
  const mipLevels = facts.find((fact) => fact.key === 'mipLevels')?.value
  return (
    <div className="binary-diff-preview__texture-viewer">
      <div ref={hostRef} className="binary-diff-preview__texture-host" aria-busy={loading} />
      {(loading || error) && (
        <div className={`binary-diff-preview__pdf-status ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>
          {error ? <FileWarning size={24} /> : <LoaderCircle className="is-spinning" size={24} />}
          <span>{error ?? t('parsingKtx2Texture')}</span>
        </div>
      )}
      {!loading && !error && facts.length > 0 && (
        <p className="binary-diff-preview__model-hint">
          {width && height ? t('status.textureDimensions', { width, height }) : fileName}
          {mipLevels ? ` · ${t('status.textureMipLevels', { count: Number(mipLevels) })}` : ''}
        </p>
      )}
    </div>
  )
}
