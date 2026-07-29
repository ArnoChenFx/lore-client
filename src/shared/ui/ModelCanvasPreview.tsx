import { FileWarning, LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Object3D, PerspectiveCamera, Scene, WebGLRenderer } from 'three'

import { t } from '../../i18n'
import { createModelPreviewObject, startModelPreviewWorker } from './modelPreviewWorkerClient'
import type { ModelPreviewFormat } from './modelPreviewWorkerProtocol'
interface ModelCanvasPreviewProps {
  fileName: string
  label: string
  data: Uint8Array
}

type OrbitControlsLike = {
  enableDamping: boolean
  dampingFactor: number
  target: { set: (x: number, y: number, z: number) => void }
  update: () => void
  dispose: () => void
}

/**
 * 解析场景背景色；忽略透明 `rgba(..., 0)`，避免 Three.js 丢弃 alpha 时的告警，
 * 并保证预览底始终是不透明纯色。
 */
function resolveSceneBackground(surface: HTMLElement, THREE: typeof import('three')) {
  const styles = getComputedStyle(surface)
  const candidates = [
    styles.getPropertyValue('--bg-code').trim(),
    styles.getPropertyValue('--bg-panel').trim(),
    styles.backgroundColor.trim()
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    const rgba = candidate.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i)
    if (rgba) {
      const alpha = rgba[4] === undefined ? 1 : Number(rgba[4])
      if (!Number.isFinite(alpha) || alpha <= 0) continue
      return new THREE.Color(Number(rgba[1]) / 255, Number(rgba[2]) / 255, Number(rgba[3]) / 255)
    }
    try {
      return new THREE.Color(candidate)
    } catch {
      // 继续尝试下一个候选色。
    }
  }
  return new THREE.Color('#1a1d24')
}

interface DisposableTexture {
  isTexture: true
  dispose: () => void
  image?: unknown
  source?: { data?: unknown }
}

interface DisposableMaterial {
  dispose: () => void
  uniforms?: Record<string, { value?: unknown }>
  [key: string]: unknown
}

/** 识别并释放材质直接引用或 Shader uniform 中的纹理。 */
function disposeTextureValue(value: unknown, disposedTextures: Set<object>) {
  if (Array.isArray(value)) {
    value.forEach((entry) => disposeTextureValue(entry, disposedTextures))
    return
  }
  if (!value || typeof value !== 'object' || !('isTexture' in value) || value.isTexture !== true) return
  if (disposedTextures.has(value)) return
  disposedTextures.add(value)
  const texture = value as DisposableTexture
  const image = texture.source?.data ?? texture.image
  if (image && typeof image === 'object' && 'close' in image && typeof image.close === 'function') {
    image.close()
  }
  texture.dispose()
}

/** 释放网格几何、材质及其纹理，避免切换前后版本时 GPU 资源泄漏。 */
export function disposeObject3D(root: Object3D) {
  const disposedGeometries = new Set<object>()
  const disposedMaterials = new Set<object>()
  const disposedTextures = new Set<object>()

  root.traverse((child) => {
    const mesh = child as Object3D & {
      geometry?: { dispose: () => void }
      material?: DisposableMaterial | DisposableMaterial[]
    }
    if (mesh.geometry && !disposedGeometries.has(mesh.geometry)) {
      disposedGeometries.add(mesh.geometry)
      mesh.geometry.dispose()
    }
    if (!mesh.material) return

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const material of materials) {
      if (disposedMaterials.has(material)) continue
      disposedMaterials.add(material)
      Object.values(material).forEach((value) => disposeTextureValue(value, disposedTextures))
      Object.values(material.uniforms ?? {}).forEach((uniform) => disposeTextureValue(uniform.value, disposedTextures))
      material.dispose()
    }
  })
}

/** 释放 Three.js 内部渲染列表并主动丢失上下文，让 WebView 归还 GPU backing store。 */
export function disposeWebGLRenderer(renderer: WebGLRenderer) {
  renderer.renderLists.dispose()
  renderer.dispose()
  renderer.forceContextLoss()
}

/** 将 Three.js / 加载器异常收敛成可操作的中文提示。 */
function describeModelError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/WebGL|webgl|context/i.test(message)) {
    return t('environmentSupportWebglModelPreview_5405')
  }
  if (/FBX|fbx/i.test(message)) {
    return t('fbxParsingFailedSingleFile_2a46')
  }
  if (/GLTF|gltf|GLB|glb/i.test(message)) {
    return t('gltfGlbParsingFailedConfirm_ee9c')
  }
  if (/OBJ|obj/i.test(message)) {
    return t('objParsingFailedInlinePreview_2596')
  }
  return t('failedParseRender3dModel_115b')
}

function modelExtension(fileName: string): string {
  return fileName.split(/[\\/]/).at(-1)?.split('.').at(-1)?.toLocaleLowerCase() ?? ''
}

/**
 * 使用 Three.js 将单文件三维模型绘制到 Canvas。
 *
 * WebGL canvas 只挂到 React 不管理子节点的宿主上，避免 Strict Mode / 卸载时
 * `removeChild` 与手动 DOM 操作冲突；每次挂载使用新 canvas，避免复用失效上下文。
 */
export function ModelCanvasPreview({ fileName, label, data }: ModelCanvasPreviewProps) {
  const { t } = useTranslation()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)

  useEffect(() => {
    const host = hostRef.current
    const surface = surfaceRef.current
    if (!host || !surface) return

    let cancelled = false
    let animationFrame = 0
    let renderer: WebGLRenderer | null = null
    let controls: OrbitControlsLike | null = null
    let scene: Scene | null = null
    let camera: PerspectiveCamera | null = null
    let root: Object3D | null = null
    let resizeObserver: ResizeObserver | null = null
    let hostCanvas: HTMLCanvasElement | null = null
    let modelWorkerTask: ReturnType<typeof startModelPreviewWorker> | null = null

    setLoading(true)
    setError(null)
    setHint(null)
    // 只清空命令式宿主；不要碰 React 负责的覆盖层节点。
    host.replaceChildren()

    void (async () => {
      try {
        const extension = modelExtension(fileName)
        if (!['obj', 'fbx', 'gltf', 'glb'].includes(extension)) {
          throw new Error(t('currentFileSupported3dModel_5266'))
        }

        const format = extension as ModelPreviewFormat
        modelWorkerTask = startModelPreviewWorker(format, data)
        // Worker 解析与主线程加载渲染器代码并行进行，任何一次选择变化都会终止前者。
        const [THREE, { OrbitControls }, parsed] = await Promise.all([
          import('three'),
          import('three/addons/controls/OrbitControls.js'),
          modelWorkerTask.promise
        ])
        if (cancelled) return

        const rebuilt = createModelPreviewObject(THREE, parsed)
        const loaded = rebuilt.root
        const precomputedBounds = { center: rebuilt.center, size: rebuilt.size }
        const nextHint =
          extension === 'obj'
            ? t('objGeometryShownSiblingMtl_3f05')
            : extension === 'fbx'
              ? t('currentFbxFileParsedExternal_9cc6')
              : extension === 'gltf'
                ? t('externalGltfBinTexturesLoaded_b0db')
                : null

        if (cancelled) {
          disposeObject3D(loaded)
          return
        }

        hostCanvas = document.createElement('canvas')
        hostCanvas.setAttribute('role', 'img')
        hostCanvas.setAttribute('aria-label', t('status.preview3d', { fileName, label }))
        host.appendChild(hostCanvas)

        scene = new THREE.Scene()
        scene.background = resolveSceneBackground(surface, THREE)

        const width = Math.max(1, Math.round(surface.clientWidth) || 480)
        const height = Math.max(1, Math.round(surface.clientHeight) || 280)
        camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 5_000)
        renderer = new THREE.WebGLRenderer({
          canvas: hostCanvas,
          antialias: true,
          alpha: false,
          powerPreference: 'low-power'
        })
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
        renderer.setSize(width, height, false)
        hostCanvas.style.width = '100%'
        hostCanvas.style.height = '100%'
        hostCanvas.style.minHeight = '280px'
        hostCanvas.style.touchAction = 'none'
        hostCanvas.style.userSelect = 'none'
        hostCanvas.style.display = 'block'

        const ambient = new THREE.AmbientLight(0xffffff, 0.72)
        const keyLight = new THREE.DirectionalLight(0xffffff, 0.95)
        keyLight.position.set(2.4, 3.2, 1.8)
        const fillLight = new THREE.DirectionalLight(0xffffff, 0.35)
        fillLight.position.set(-2.2, 1.2, -1.6)
        scene.add(ambient, keyLight, fillLight)

        root = loaded
        scene.add(root)

        const size = precomputedBounds?.size ?? new THREE.Vector3()
        const center = precomputedBounds?.center ?? new THREE.Vector3()
        if (!precomputedBounds) {
          const box = new THREE.Box3().setFromObject(root)
          box.getSize(size)
          box.getCenter(center)
        }
        if (Number.isFinite(center.x) && Number.isFinite(center.y) && Number.isFinite(center.z)) {
          root.position.sub(center)
        }

        const radius = Math.max(size.length() / 2, 0.5)
        camera.position.set(radius * 1.6, radius * 1.1, radius * 1.8)
        camera.near = Math.max(radius / 200, 0.01)
        camera.far = Math.max(radius * 40, 100)
        camera.updateProjectionMatrix()

        controls = new OrbitControls(camera, hostCanvas) as OrbitControlsLike
        controls.enableDamping = true
        controls.dampingFactor = 0.08
        controls.target.set(0, 0, 0)
        controls.update()

        const renderFrame = () => {
          if (cancelled || !renderer || !scene || !camera || !controls) return
          controls.update()
          renderer.render(scene, camera)
          animationFrame = window.requestAnimationFrame(renderFrame)
        }
        renderFrame()

        const syncSize = () => {
          if (!renderer || !camera || !surface) return
          const nextWidth = Math.max(1, Math.round(surface.clientWidth) || 480)
          const nextHeight = Math.max(1, Math.round(surface.clientHeight) || 280)
          camera.aspect = nextWidth / nextHeight
          camera.updateProjectionMatrix()
          renderer.setSize(nextWidth, nextHeight, false)
        }
        resizeObserver = new ResizeObserver(syncSize)
        resizeObserver.observe(surface)

        if (!cancelled) {
          setHint(nextHint)
          setLoading(false)
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(describeModelError(loadError))
          setLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
      // Worker.terminate 可以中断 OBJ/FBX 同步解析和 GLTF Promise 链；仅设 cancelled
      // 只能忽略结果，无法阻止过期任务继续占用 CPU 与内存。
      modelWorkerTask?.cancel()
      window.cancelAnimationFrame(animationFrame)
      resizeObserver?.disconnect()
      controls?.dispose()
      if (root) {
        scene?.remove(root)
        disposeObject3D(root)
      }
      if (renderer) disposeWebGLRenderer(renderer)
      // 只清理命令式宿主，避免 React 随后再 removeChild 同一节点。
      host.replaceChildren()
    }
  }, [data, fileName, label, t])

  return (
    <div className="binary-diff-preview__model-viewer" aria-label={t('status.previewModel', { fileName, label })}>
      <div ref={surfaceRef} className="binary-diff-preview__model-surface" aria-busy={loading}>
        <div ref={hostRef} className="binary-diff-preview__model-host" />
        {loading && !error && (
          <div className="binary-diff-preview__pdf-status" role="status">
            <LoaderCircle className="is-spinning" size={24} />
            <span>{t('parsing3dModel')}</span>
          </div>
        )}
        {error && (
          <div className="binary-diff-preview__pdf-status is-error" role="alert">
            <FileWarning size={24} />
            <span>{error}</span>
          </div>
        )}
      </div>
      {hint && !error && <p className="binary-diff-preview__model-hint">{hint}</p>}
    </div>
  )
}
