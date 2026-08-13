import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createModelPreviewObject, startModelPreviewWorker } from './modelPreviewWorkerClient'
import type { ModelPreviewWorkerResult } from './modelPreviewWorkerProtocol'

const originalWorker = globalThis.Worker

class FakeWorker {
  static latest: FakeWorker | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()

  constructor() {
    FakeWorker.latest = this
  }
}

describe('model preview worker client', () => {
  afterEach(() => {
    if (originalWorker) globalThis.Worker = originalWorker
    else Reflect.deleteProperty(globalThis, 'Worker')
    FakeWorker.latest = null
  })

  it('terminates and rejects a superseded parse without detaching source data', async () => {
    // FakeWorker 是测试替身，不能直接断言为全局 Worker 构造器；双重断言是
    // 测试标准做法。
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    globalThis.Worker = FakeWorker as unknown as typeof Worker
    const source = new Uint8Array([70, 66, 88, 32, 55, 53, 48, 48])
    const task = startModelPreviewWorker('fbx', source)
    const worker = FakeWorker.latest!

    expect(worker.postMessage).toHaveBeenCalledOnce()
    expect(worker.postMessage.mock.calls[0]?.[0]).toMatchObject({ type: 'parseModel', format: 'fbx' })
    expect(source.byteLength).toBe(8)
    task.cancel()

    await expect(task.promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('rebuilds indexed geometry, materials, and worker-computed bounds', () => {
    const result: ModelPreviewWorkerResult = {
      type: 'result',
      requestId: 1,
      format: 'glb',
      textures: [],
      primitives: [
        {
          kind: 'mesh',
          name: 'Triangle',
          attributes: [
            {
              name: 'position',
              itemSize: 3,
              values: new Float32Array([0, 0, 0, 2, 0, 0, 0, 4, 0])
            },
            {
              name: 'normal',
              itemSize: 3,
              values: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])
            }
          ],
          index: { values: new Uint16Array([0, 1, 2]) },
          groups: [],
          materials: [
            {
              model: 'standard',
              name: 'Body',
              color: 0x336699,
              emissive: 0x000000,
              opacity: 0.75,
              transparent: true,
              wireframe: false,
              side: 2,
              roughness: 0.4,
              metalness: 0.2,
              shininess: 30,
              size: 1,
              mapIndex: null
            }
          ]
        }
      ],
      bounds: { min: [0, 0, 0], max: [2, 4, 0] }
    }

    const rebuilt = createModelPreviewObject(THREE, result)
    const mesh = rebuilt.root.children[0] as THREE.Mesh
    const material = mesh.material as THREE.MeshStandardMaterial

    expect(mesh.name).toBe('Triangle')
    expect(mesh.frustumCulled).toBe(false)
    expect(Array.from(mesh.geometry.getAttribute('position').array)).toEqual([0, 0, 0, 2, 0, 0, 0, 4, 0])
    expect(Array.from(mesh.geometry.getIndex()!.array)).toEqual([0, 1, 2])
    expect(material.name).toBe('Body')
    expect(material.color.getHex()).toBe(0x336699)
    expect(material.opacity).toBe(0.75)
    expect(rebuilt.center.toArray()).toEqual([1, 2, 0])
    expect(rebuilt.size.toArray()).toEqual([2, 4, 0])
  })
})
