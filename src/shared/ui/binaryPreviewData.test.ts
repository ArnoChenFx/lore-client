import { describe, expect, it } from 'vitest'

import type { BinaryDiffPreview } from '../../types'
import { createBinaryDiffPreviewView, readBinaryPreviewData } from './binaryPreviewData'

/**
 * 模拟 React 19 开发性能轨迹对变化 props 的有限深度枚举。
 * Uint8Array 的数字索引都是可枚举属性，因此不能直接进入组件 props。
 */
function countEnumerableProperties(value: unknown, maximumDepth = 3, depth = 0): number {
  if (!value || typeof value !== 'object' || depth >= maximumDepth) return 0
  let count = 0
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    count += 1
    count += countEnumerableProperties((value as Record<string, unknown>)[key], maximumDepth, depth + 1)
  }
  return count
}

describe('binary preview data view', () => {
  it('keeps large preview bytes opaque to React development prop inspection without copying', () => {
    // 64 KiB 已足以稳定暴露逐字节枚举，同时避免单元测试本身消耗数秒。
    const bytes = new Uint8Array(64 * 1024)
    const preview: BinaryDiffPreview = {
      after: {
        path: 'modle/sphere.obj',
        kind: 'model',
        mimeType: 'model/obj',
        data: bytes,
        size: bytes.byteLength,
        contentState: 'available'
      }
    }

    const view = createBinaryDiffPreviewView(preview)

    expect(countEnumerableProperties(preview)).toBeGreaterThan(bytes.byteLength)
    expect(countEnumerableProperties(view)).toBeLessThan(16)
    expect(Object.keys(view.after!.data)).toEqual([])
    expect(readBinaryPreviewData(view.after!.data)).toBe(bytes)
  })
})
