import type { Material, Object3D } from 'three'

import type {
  ModelPreviewFormat,
  ModelPreviewMaterial,
  ModelPreviewWorkerRequest,
  ModelPreviewWorkerResponse,
  ModelPreviewWorkerResult
} from './modelPreviewWorkerProtocol'

interface ModelPreviewWorkerTask {
  promise: Promise<ModelPreviewWorkerResult>
  cancel: () => void
}

let nextModelPreviewRequestId = 0

/**
 * 在独立模块 Worker 中解析三维模型。
 *
 * 输入必须复制后再 transfer，不能 detach React state 持有的原始预览缓冲；选择变化时
 * `cancel` 会直接终止 Worker，确保过期的同步解析或 Promise 链不再继续占用 CPU。
 */
export function startModelPreviewWorker(format: ModelPreviewFormat, data: Uint8Array): ModelPreviewWorkerTask {
  nextModelPreviewRequestId += 1
  const requestId = nextModelPreviewRequestId
  const worker = new Worker(new URL('./modelPreview.worker.ts', import.meta.url), {
    type: 'module',
    name: `lore-${format}-preview`
  })
  let settled = false
  let resolveResult: (result: ModelPreviewWorkerResult) => void = () => undefined
  let rejectResult: (reason: unknown) => void = () => undefined
  const promise = new Promise<ModelPreviewWorkerResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  const finish = () => {
    worker.onmessage = null
    worker.onerror = null
    worker.terminate()
  }
  worker.onmessage = (event: MessageEvent<ModelPreviewWorkerResponse>) => {
    if (settled || event.data.requestId !== requestId) return
    settled = true
    finish()
    if (event.data.type === 'error') rejectResult(new Error(event.data.message))
    else resolveResult(event.data)
  }
  worker.onerror = (event) => {
    if (settled) return
    settled = true
    finish()
    rejectResult(new Error(event.message || `${format.toUpperCase()} preview worker failed`))
  }

  const transferableData = data.slice().buffer
  const request: ModelPreviewWorkerRequest = {
    type: 'parseModel',
    requestId,
    format,
    data: transferableData
  }
  worker.postMessage(request, [transferableData])

  return {
    promise,
    cancel: () => {
      if (settled) return
      settled = true
      finish()
      rejectResult(new DOMException(`${format.toUpperCase()} preview parsing was superseded`, 'AbortError'))
    }
  }
}

function createMaterial(
  THREE: typeof import('three'),
  descriptor: ModelPreviewMaterial,
  usesVertexColors: boolean,
  textures: import('three').Texture[]
): Material {
  const common = {
    color: descriptor.color,
    map: descriptor.mapIndex == null ? null : textures[descriptor.mapIndex],
    opacity: descriptor.opacity,
    transparent: descriptor.transparent,
    side: descriptor.side,
    vertexColors: usesVertexColors
  }
  let material: Material
  if (descriptor.model === 'line') material = new THREE.LineBasicMaterial(common)
  else if (descriptor.model === 'points') {
    material = new THREE.PointsMaterial({
      ...common,
      size: descriptor.size,
      sizeAttenuation: false
    })
  } else if (descriptor.model === 'basic') {
    material = new THREE.MeshBasicMaterial({ ...common, wireframe: descriptor.wireframe })
  } else if (descriptor.model === 'standard') {
    material = new THREE.MeshStandardMaterial({
      ...common,
      emissive: descriptor.emissive,
      roughness: descriptor.roughness,
      metalness: descriptor.metalness,
      wireframe: descriptor.wireframe
    })
  } else {
    material = new THREE.MeshPhongMaterial({
      ...common,
      emissive: descriptor.emissive,
      shininess: descriptor.shininess,
      wireframe: descriptor.wireframe
    })
  }
  material.name = descriptor.name
  return material
}

/** 用 Worker 返回的可转移几何缓冲重建轻量 Three.js 静态场景。 */
export function createModelPreviewObject(THREE: typeof import('three'), result: ModelPreviewWorkerResult) {
  const root = new THREE.Group()
  const textures = result.textures.map((descriptor) => {
    const texture = new THREE.Texture(descriptor.image)
    texture.colorSpace = descriptor.colorSpace as import('three').ColorSpace
    texture.flipY = descriptor.flipY
    texture.needsUpdate = true
    return texture
  })
  for (const primitive of result.primitives) {
    const geometry = new THREE.BufferGeometry()
    for (const attribute of primitive.attributes) {
      geometry.setAttribute(attribute.name, new THREE.BufferAttribute(attribute.values, attribute.itemSize, false))
    }
    if (primitive.index) geometry.setIndex(new THREE.BufferAttribute(primitive.index.values, 1, false))
    primitive.groups.forEach((group) => geometry.addGroup(group.start, group.count, group.materialIndex))
    const usesVertexColors = geometry.hasAttribute('color')
    const materials = primitive.materials.map((material) => createMaterial(THREE, material, usesVertexColors, textures))
    const material = materials.length === 1 || primitive.groups.length === 0 ? materials[0] : materials

    let object: Object3D
    if (primitive.kind === 'lineSegments') object = new THREE.LineSegments(geometry, material)
    else if (primitive.kind === 'points') object = new THREE.Points(geometry, material)
    else object = new THREE.Mesh(geometry, material)
    object.name = primitive.name
    // 整体包围盒已由 Worker 计算；关闭逐对象视锥剔除可避免渲染器再次扫描所有顶点。
    object.frustumCulled = false
    root.add(object)
  }

  const minimum = result.bounds ? new THREE.Vector3(...result.bounds.min) : new THREE.Vector3(-0.5, -0.5, -0.5)
  const maximum = result.bounds ? new THREE.Vector3(...result.bounds.max) : new THREE.Vector3(0.5, 0.5, 0.5)
  const size = maximum.clone().sub(minimum)
  const center = minimum.clone().add(maximum).multiplyScalar(0.5)
  return { root, center, size }
}
