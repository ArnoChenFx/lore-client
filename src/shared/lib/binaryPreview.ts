import type { BinaryPreviewKind } from '../../types'

/**
 * 前后端共同支持的内嵌预览格式。
 *
 * SVG 虽然是文本源文件，但启用二进制 Diff 时可作为图片预览。Rust 边界必须先
 * 拒绝外部资源并栅格化为 PNG，原始 SVG 字节绝不能进入 WebView。
 *
 * TGA/TIFF 在 Rust 边界转成 PNG 后仍以 `image` 下发；OBJ/FBX/GLTF/GLB 以
 * `model` 下发，由前端 Canvas 解析，且禁止加载器拉取外部材质或缓冲。
 * CSV 以表格预览下发；它同时保留在文本类白名单中，便于 Lore 生成行级 Diff。
 */
// 扩展名 → 预览类别查找表：扩展名来自用户文件系统，interface 的索引签名保持
// open 字典语义，同时作为 named owner contract 通过 anti-slop no-known-value-widening。
interface PreviewKindsByExtension {
  readonly [extension: string]: BinaryPreviewKind
}
const previewKindsByExtension: PreviewKindsByExtension = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  ico: 'image',
  tga: 'image',
  tif: 'image',
  tiff: 'image',
  dds: 'image',
  exr: 'image',
  ktx2: 'texture',
  pdf: 'pdf',
  obj: 'model',
  fbx: 'model',
  gltf: 'model',
  glb: 'model',
  csv: 'csv',
  svg: 'image',
  wav: 'audio',
  ogg: 'audio',
  mp3: 'audio',
  flac: 'audio',
  zip: 'archive',
  pak: 'archive',
  assetbundle: 'archive',
  bundle: 'archive',
  unity3d: 'archive',
  pck: 'archive',
  ttf: 'font',
  otf: 'font',
  uasset: 'asset',
  umap: 'asset',
  uexp: 'asset',
  ubulk: 'asset',
  assets: 'asset',
  res: 'asset',
  blend: 'asset'
}

/** 返回路径可使用的内嵌预览类型；未知或高风险格式明确返回 `null`。 */
export function binaryPreviewKind(path: string): BinaryPreviewKind | null {
  const normalized = path.split(/[?#]/, 1)[0]?.replaceAll('\\', '/') ?? ''
  const fileName = normalized.split('/').at(-1) ?? ''
  const dotIndex = fileName.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) return null
  return previewKindsByExtension[fileName.slice(dotIndex + 1).toLocaleLowerCase()] ?? null
}

/** 为会转移或接管 ArrayBuffer 的解析器创建独立字节所有权。 */
export function copyBinaryPreviewData(data: Uint8Array): Uint8Array {
  return data.slice()
}

/** 统一格式化预览真实字节大小，避免图片与 PDF 卡片各自维护单位换算。 */
export function formatPreviewBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1_024)), units.length - 1)
  const value = bytes / 1_024 ** unitIndex
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}
