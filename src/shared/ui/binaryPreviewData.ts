import type { BinaryDiffPreview, BinaryFilePreview } from '../../types'

/**
 * 大型预览正文的非枚举句柄。
 *
 * React 19 开发构建会为性能轨迹递归枚举变化的组件 props。Uint8Array 的每个数字索引
 * 都是可枚举属性，6 MiB 模型因此会在主线程生成数百万条调试属性。正文放入 WeakMap
 * 后，组件仍可零拷贝读取原始字节，而 React 只能看到没有自有属性的轻量句柄。
 */
export class BinaryPreviewData {
  constructor(data: Uint8Array) {
    binaryPreviewDataStore.set(this, data)
    Object.freeze(this)
  }
}

const binaryPreviewDataStore = new WeakMap<BinaryPreviewData, Uint8Array>()

export interface BinaryFilePreviewView extends Omit<BinaryFilePreview, 'data'> {
  data: BinaryPreviewData
}

export interface BinaryDiffPreviewView {
  before?: BinaryFilePreviewView
  after?: BinaryFilePreviewView
}

export function readBinaryPreviewData(data: BinaryPreviewData): Uint8Array {
  const value = binaryPreviewDataStore.get(data)
  if (!value) throw new Error('Binary preview data handle is no longer available')
  return value
}

function createBinaryFilePreviewView(preview: BinaryFilePreview): BinaryFilePreviewView {
  return {
    ...preview,
    data: new BinaryPreviewData(preview.data)
  }
}

/** 将稳定 IPC DTO 转成只服务于 React 视图层的非枚举正文投影。 */
export function createBinaryDiffPreviewView(preview: BinaryDiffPreview): BinaryDiffPreviewView {
  return {
    before: preview.before ? createBinaryFilePreviewView(preview.before) : undefined,
    after: preview.after ? createBinaryFilePreviewView(preview.after) : undefined
  }
}
