export type ModelPreviewFormat = 'obj' | 'fbx' | 'gltf' | 'glb'

/** Worker 可重建的几何属性；骨骼与 Morph 会先烘焙到 position/normal。 */
export interface ModelPreviewGeometryAttribute {
  name: 'position' | 'normal' | 'uv' | 'color'
  itemSize: number
  values: Float32Array<ArrayBuffer>
}

/** 保留索引可避免大型 FBX/GLTF 在跨线程传输时被强制展开成重复顶点。 */
export interface ModelPreviewGeometryIndex {
  values: Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>
}

/** 可安全转移的内嵌基础色贴图；外部 URL 在 Worker LoadingManager 中已被替换。 */
export interface ModelPreviewTexture {
  image: ImageBitmap
  colorSpace: string
  flipY: boolean
}

/**
 * 预览只保留无需外部资源即可稳定重建的材质参数。
 *
 * 只有 Worker 已安全解码为 ImageBitmap 的基础色贴图会跨边界传输；仓库外引用仍被
 * 替换为占位图，其他贴图通道不参与当前静态预览。
 */
export interface ModelPreviewMaterial {
  model: 'basic' | 'phong' | 'standard' | 'line' | 'points'
  name: string
  color: number
  emissive: number
  opacity: number
  transparent: boolean
  wireframe: boolean
  side: 0 | 1 | 2
  roughness: number
  metalness: number
  shininess: number
  size: number
  mapIndex: number | null
}

/** 解析后的静态绘制原语；世界变换、当前骨骼姿态与 Morph 已在 Worker 中烘焙。 */
export interface ModelPreviewPrimitive {
  kind: 'mesh' | 'lineSegments' | 'points'
  name: string
  attributes: ModelPreviewGeometryAttribute[]
  index: ModelPreviewGeometryIndex | null
  groups: Array<{ start: number; count: number; materialIndex: number }>
  materials: ModelPreviewMaterial[]
}

/** Worker 已计算的整体包围盒，避免主线程为了摆放相机再次遍历全部顶点。 */
export interface ModelPreviewBounds {
  min: [number, number, number]
  max: [number, number, number]
}

export interface ModelPreviewWorkerResult {
  type: 'result'
  requestId: number
  format: ModelPreviewFormat
  primitives: ModelPreviewPrimitive[]
  textures: ModelPreviewTexture[]
  bounds: ModelPreviewBounds | null
}

export interface ModelPreviewWorkerFailure {
  type: 'error'
  requestId: number
  format: ModelPreviewFormat
  message: string
}

export interface ModelPreviewWorkerRequest {
  type: 'parseModel'
  requestId: number
  format: ModelPreviewFormat
  data: ArrayBuffer
}

export type ModelPreviewWorkerResponse = ModelPreviewWorkerResult | ModelPreviewWorkerFailure
