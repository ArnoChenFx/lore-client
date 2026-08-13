import type { BufferAttribute, BufferGeometry, InterleavedBufferAttribute, Material, Mesh, Object3D } from 'three'
import { Box3, LoadingManager, Matrix4, Vector3 } from 'three'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'

import type {
  ModelPreviewFormat,
  ModelPreviewGeometryAttribute,
  ModelPreviewGeometryIndex,
  ModelPreviewMaterial,
  ModelPreviewPrimitive,
  ModelPreviewTexture,
  ModelPreviewWorkerFailure,
  ModelPreviewWorkerRequest,
  ModelPreviewWorkerResponse
} from './modelPreviewWorkerProtocol'

const transferableAttributeNames = ['position', 'normal', 'uv', 'color'] as const
const maximumTransferBytes = 128 * 1024 * 1024
const maximumPrimitiveCount = 20_000
const blockedTextureDataUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

interface TransferBudget {
  bytes: number
  primitives: number
}

interface TextureSerializationContext {
  budget: TransferBudget
  ids: Map<object, number>
  textures: ModelPreviewTexture[]
  transferables: Transferable[]
}

type PreviewObject = Object3D & {
  isMesh?: boolean
  isSkinnedMesh?: boolean
  isInstancedMesh?: boolean
  isLineSegments?: boolean
  isPoints?: boolean
  count?: number
  geometry?: BufferGeometry
  material?: Material | Material[]
  morphTargetInfluences?: number[]
  skeleton?: { update: () => void }
  getMatrixAt?: (index: number, matrix: Matrix4) => void
  getVertexPosition?: (index: number, target: Vector3) => Vector3
}

type PreviewMaterial = Material & {
  isMeshBasicMaterial?: boolean
  isMeshStandardMaterial?: boolean
  isMeshPhysicalMaterial?: boolean
  color?: { getHex: () => number }
  emissive?: { getHex: () => number }
  opacity?: number
  transparent?: boolean
  wireframe?: boolean
  side?: number
  roughness?: number
  metalness?: number
  shininess?: number
  size?: number
  map?: {
    image?: unknown
    colorSpace?: string
    flipY?: boolean
  } | null
}

/**
 * FBXLoader 固定使用 ImageLoader，而 Worker 没有 HTMLImageElement。
 *
 * 这个替身只让 FBXLoader 跳过 DOM 访问，不会伪装成可传输贴图；URLModifier 仍负责
 * 把外部 URL 替换为内置占位数据。只有加载器真正解码成 ImageBitmap 的内嵌基础色贴图
 * 才会进入跨线程结果，避免外部资源绕过单文件预览边界。
 */
function installWorkerImageStub() {
  if ('document' in globalThis) return
  const documentStub = {
    createElementNS: (_namespace: string, qualifiedName: string) => {
      if (qualifiedName !== 'img') throw new Error(`Unsupported worker element: ${qualifiedName}`)
      const listeners = new Map<string, Set<(event: Event) => void>>()
      let source = ''
      const image = {
        crossOrigin: '',
        width: 1,
        height: 1,
        naturalWidth: 1,
        naturalHeight: 1,
        addEventListener(type: string, listener: (event: Event) => void) {
          const entries = listeners.get(type) ?? new Set()
          entries.add(listener)
          listeners.set(type, entries)
        },
        removeEventListener(type: string, listener: (event: Event) => void) {
          listeners.get(type)?.delete(listener)
        },
        get src() {
          return source
        },
        set src(value: string) {
          source = value
          queueMicrotask(() => {
            // Worker 环境没有真实 DOM 事件；构造最小 load 事件并指向图片对象。
            const event = new Event('load')
            Object.defineProperty(event, 'target', { configurable: true, value: image })
            listeners.get('load')?.forEach((listener) => listener.call(image, event))
          })
        }
      }
      return image
    }
  }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentStub })
}

/**
 * WebView2 Worker 提供 ProgressEvent；Bun 等无 DOM Worker 不一定提供。
 * 补齐 Three.js FileLoader 只读进度字段需要的最小实现，让同一 Worker 可接受自动化回归。
 */
function installWorkerProgressEventStub() {
  if ('ProgressEvent' in globalThis) return
  class WorkerProgressEvent extends Event {
    readonly lengthComputable: boolean
    readonly loaded: number
    readonly total: number

    constructor(type: string, init: ProgressEventInit = {}) {
      super(type)
      this.lengthComputable = init.lengthComputable ?? false
      this.loaded = init.loaded ?? 0
      this.total = init.total ?? 0
    }
  }
  Object.defineProperty(globalThis, 'ProgressEvent', { configurable: true, value: WorkerProgressEvent })
}

/** 拒绝仓库外资源，同时允许文件内部生成的 data/blob URL 完成单文件解析。 */
function createIsolatedLoadingManager() {
  const manager = new LoadingManager()
  manager.setURLModifier((url) => {
    const normalized = url.trim()
    if (normalized.startsWith('blob:') || normalized.startsWith('data:') || normalized.startsWith('data%3A')) {
      return url
    }
    return blockedTextureDataUrl
  })
  return manager
}

function consumeTransferBudget(budget: TransferBudget, bytes: number) {
  budget.bytes += bytes
  if (budget.bytes > maximumTransferBytes) {
    throw new Error('Model preview geometry exceeds the 128 MiB worker transfer limit')
  }
}

/** 统一复制普通或交错属性，输出反归一化后的独占 Float32Array。 */
function serializeAttribute(
  name: ModelPreviewGeometryAttribute['name'],
  attribute: BufferAttribute | InterleavedBufferAttribute,
  budget: TransferBudget
) {
  const values = new Float32Array(attribute.count * attribute.itemSize)
  for (let index = 0; index < attribute.count; index += 1) {
    for (let component = 0; component < attribute.itemSize; component += 1) {
      values[index * attribute.itemSize + component] = attribute.getComponent(index, component)
    }
  }
  consumeTransferBudget(budget, values.byteLength)
  return {
    attribute: { name, itemSize: attribute.itemSize, values } satisfies ModelPreviewGeometryAttribute,
    transferable: values.buffer
  }
}

function serializeIndex(geometry: BufferGeometry, budget: TransferBudget) {
  const source = geometry.getIndex()
  if (!source) return { index: null, transferable: null }
  const values =
    source.array instanceof Uint32Array
      ? Uint32Array.from(source.array)
      : Uint16Array.from(source.array as ArrayLike<number>)
  consumeTransferBudget(budget, values.byteLength)
  return { index: { values }, transferable: values.buffer }
}

function materialModel(material: PreviewMaterial, kind: ModelPreviewPrimitive['kind']): ModelPreviewMaterial['model'] {
  if (kind === 'lineSegments') return 'line'
  if (kind === 'points') return 'points'
  if (material.isMeshBasicMaterial) return 'basic'
  if (material.isMeshStandardMaterial || material.isMeshPhysicalMaterial) return 'standard'
  return 'phong'
}

function serializeTexture(texture: PreviewMaterial['map'], context: TextureSerializationContext): number | null {
  if (!texture || typeof ImageBitmap === 'undefined' || !(texture.image instanceof ImageBitmap)) return null
  const existing = context.ids.get(texture)
  if (existing !== undefined) return existing
  consumeTransferBudget(context.budget, texture.image.width * texture.image.height * 4)
  const index = context.textures.length
  context.ids.set(texture, index)
  context.textures.push({
    image: texture.image,
    colorSpace: texture.colorSpace ?? '',
    flipY: texture.flipY ?? false
  })
  context.transferables.push(texture.image)
  return index
}

function serializeMaterial(
  material: Material | undefined,
  kind: ModelPreviewPrimitive['kind'],
  textureContext: TextureSerializationContext
): ModelPreviewMaterial {
  const candidate = material as PreviewMaterial | undefined
  const side = candidate?.side === 1 || candidate?.side === 2 ? candidate.side : 0
  return {
    model: candidate
      ? materialModel(candidate, kind)
      : kind === 'lineSegments'
        ? 'line'
        : kind === 'points'
          ? 'points'
          : 'phong',
    name: candidate?.name ?? '',
    color: candidate?.color?.getHex() ?? 0xffffff,
    emissive: candidate?.emissive?.getHex() ?? 0x000000,
    opacity: candidate?.opacity ?? 1,
    transparent: candidate?.transparent ?? false,
    wireframe: candidate?.wireframe ?? false,
    side,
    roughness: candidate?.roughness ?? 1,
    metalness: candidate?.metalness ?? 0,
    shininess: candidate?.shininess ?? 30,
    size: candidate?.size ?? 1,
    mapIndex: serializeTexture(candidate?.map, textureContext)
  }
}

/**
 * 克隆并烘焙一个绘制对象。
 *
 * SkinnedMesh 与激活的 Morph 通过 getVertexPosition 取得当前可见姿态，再重新计算法线；
 * 普通几何直接应用世界矩阵。主线程因此不需要重建骨骼、层级或动画运行时。
 */
function prepareGeometry(candidate: PreviewObject, worldMatrix: Matrix4): BufferGeometry {
  const geometry = candidate.geometry!.clone()
  const hasMorph = candidate.morphTargetInfluences?.some((influence) => influence !== 0) ?? false
  const shouldBakePose = candidate.isMesh && (candidate.isSkinnedMesh || hasMorph) && candidate.getVertexPosition
  if (shouldBakePose) {
    candidate.skeleton?.update()
    const position = geometry.getAttribute('position')
    const vertex = new Vector3()
    for (let index = 0; index < position.count; index += 1) {
      candidate.getVertexPosition!(index, vertex).applyMatrix4(worldMatrix)
      position.setXYZ(index, vertex.x, vertex.y, vertex.z)
    }
    geometry.deleteAttribute('normal')
    geometry.computeVertexNormals()
  } else {
    geometry.applyMatrix4(worldMatrix)
    if (candidate.isMesh && !geometry.getAttribute('normal')) geometry.computeVertexNormals()
  }
  geometry.computeBoundingBox()
  return geometry
}

function serializePrimitive(
  candidate: PreviewObject,
  worldMatrix: Matrix4,
  name: string,
  textureContext: TextureSerializationContext
) {
  const { budget } = textureContext
  budget.primitives += 1
  if (budget.primitives > maximumPrimitiveCount) {
    throw new Error('Model preview exceeds the 20,000 primitive limit')
  }

  const geometry = prepareGeometry(candidate, worldMatrix)
  const attributes: ModelPreviewGeometryAttribute[] = []
  const transferables: Transferable[] = []
  for (const attributeName of transferableAttributeNames) {
    const attribute = geometry.getAttribute(attributeName)
    if (!attribute) continue
    const serialized = serializeAttribute(attributeName, attribute, budget)
    attributes.push(serialized.attribute)
    transferables.push(serialized.transferable)
  }
  const serializedIndex = serializeIndex(geometry, budget)
  if (serializedIndex.transferable) transferables.push(serializedIndex.transferable)

  const kind = candidate.isLineSegments ? 'lineSegments' : candidate.isPoints ? 'points' : 'mesh'
  const sourceMaterials = Array.isArray(candidate.material) ? candidate.material : [candidate.material]
  const materials = sourceMaterials
    .filter((material): material is Material => Boolean(material))
    .map((material) => serializeMaterial(material, kind, textureContext))
  if (materials.length === 0) materials.push(serializeMaterial(undefined, kind, textureContext))

  const primitive: ModelPreviewPrimitive = {
    kind,
    name,
    attributes,
    index: serializedIndex.index,
    groups: geometry.groups.map((group) => ({
      start: group.start,
      count: group.count,
      materialIndex: group.materialIndex ?? 0
    })),
    materials
  }
  const bounds = geometry.boundingBox?.clone() ?? new Box3()
  geometry.dispose()
  return { primitive, transferables, bounds }
}

function serializeScene(root: Object3D, request: ModelPreviewWorkerRequest) {
  root.updateMatrixWorld(true)
  const primitives: ModelPreviewPrimitive[] = []
  const transferables: Transferable[] = []
  const bounds = new Box3()
  const budget: TransferBudget = { bytes: 0, primitives: 0 }
  const textureContext: TextureSerializationContext = {
    budget,
    ids: new Map(),
    textures: [],
    transferables
  }
  let hasBounds = false

  root.traverse((child) => {
    const candidate = child as PreviewObject
    if (!candidate.geometry || (!candidate.isMesh && !candidate.isLineSegments && !candidate.isPoints)) return

    const instanceCount = candidate.isInstancedMesh ? Math.max(0, candidate.count ?? 0) : 1
    for (let instanceIndex = 0; instanceIndex < instanceCount; instanceIndex += 1) {
      const worldMatrix = child.matrixWorld.clone()
      let name = child.name
      if (candidate.isInstancedMesh && candidate.getMatrixAt) {
        const instanceMatrix = new Matrix4()
        candidate.getMatrixAt(instanceIndex, instanceMatrix)
        worldMatrix.multiply(instanceMatrix)
        name = `${child.name || 'Instance'} ${instanceIndex + 1}`
      }
      const serialized = serializePrimitive(candidate, worldMatrix, name, textureContext)
      primitives.push(serialized.primitive)
      transferables.push(...serialized.transferables)
      if (!serialized.bounds.isEmpty()) {
        bounds.union(serialized.bounds)
        hasBounds = true
      }
    }
  })

  // 去掉显式返回类型后，type 需要 const 断言保持字面量（serializeScene 的调用方
  // parseModel 声明返回 ModelPreviewWorkerResponse）。
  const response: ModelPreviewWorkerResponse = {
    type: 'result',
    requestId: request.requestId,
    format: request.format,
    primitives,
    textures: textureContext.textures,
    bounds: hasBounds
      ? {
          min: new Vector3().copy(bounds.min).toArray() as [number, number, number],
          max: new Vector3().copy(bounds.max).toArray() as [number, number, number]
        }
      : null
  }
  return { response, transferables }
}

async function parseModel(request: ModelPreviewWorkerRequest): Promise<{
  response: ModelPreviewWorkerResponse
  transferables: Transferable[]
}> {
  installWorkerImageStub()
  installWorkerProgressEventStub()
  const manager = createIsolatedLoadingManager()
  let root: Object3D
  if (request.format === 'obj') {
    root = new OBJLoader(manager).parse(new TextDecoder().decode(request.data))
  } else if (request.format === 'fbx') {
    root = new FBXLoader(manager).parse(request.data, '')
  } else {
    root = await new Promise<Object3D>((resolve, reject) => {
      new GLTFLoader(manager).parse(
        request.data,
        '',
        (gltf) => resolve(gltf.scene),
        (error) => reject(error)
      )
    })
  }
  return serializeScene(root, request)
}

self.onmessage = (event: MessageEvent<ModelPreviewWorkerRequest>) => {
  const request = event.data
  if (request.type !== 'parseModel') return
  void parseModel(request)
    .then(({ response, transferables }) => self.postMessage(response, { transfer: transferables }))
    .catch((error) => {
      const response: ModelPreviewWorkerFailure = {
        type: 'error',
        requestId: request.requestId,
        format: request.format,
        message: error instanceof Error ? error.message : String(error)
      }
      self.postMessage(response)
    })
}
