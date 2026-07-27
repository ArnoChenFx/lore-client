import type { BinaryPreviewKind } from '../../types'

/**
 * 前后端共同支持的内嵌预览格式。
 *
 * SVG 即使经常被当作图片，也可能包含脚本、外部资源与链接，因此不进入二进制
 * 内嵌预览白名单；它仍可走现有“打开文件”能力交给用户选择的外部应用。
 *
 * TGA/TIFF 在 Rust 边界转成 PNG 后仍以 `image` 下发；OBJ/FBX/GLTF/GLB 以
 * `model` 下发，由前端 Canvas 解析，且禁止加载器拉取外部材质或缓冲。
 * CSV 以表格预览下发；它同时保留在文本类白名单中，便于 Lore 生成行级 Diff。
 */
const previewKindsByExtension: Readonly<Record<string, BinaryPreviewKind>> = {
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

/**
 * 把 IPC Base64 还原为独立字节数组，供 PDF.js / Three.js 接管所有权。
 *
 * 不生成 data URL 或 Blob URL，避免把可解析内容交给 WebView 原生查看器。
 */
export function decodeBinaryPreviewBase64(dataBase64: string): Uint8Array {
  const binary = atob(dataBase64.replaceAll(/\s/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/** 统一格式化预览真实字节大小，避免图片与 PDF 卡片各自维护单位换算。 */
export function formatPreviewBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1_024)), units.length - 1)
  const value = bytes / 1_024 ** unitIndex
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}
