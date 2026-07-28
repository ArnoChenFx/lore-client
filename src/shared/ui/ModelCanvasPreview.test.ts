import { describe, expect, it, vi } from 'vitest'

import { disposeObject3D, disposeWebGLRenderer } from './ModelCanvasPreview'

describe('model canvas resource disposal', () => {
  it('disposes shared material textures exactly once', () => {
    const disposeTexture = vi.fn()
    const disposeMaterial = vi.fn()
    const disposeGeometry = vi.fn()
    const texture = { isTexture: true, dispose: disposeTexture }
    const geometry = { dispose: disposeGeometry }
    const material = {
      map: texture,
      normalMap: texture,
      dispose: disposeMaterial
    }
    const root = {
      traverse(visitor: (child: unknown) => void) {
        visitor({ geometry, material })
        visitor({ geometry, material })
      }
    }

    disposeObject3D(root as never)

    expect(disposeTexture).toHaveBeenCalledTimes(1)
    expect(disposeMaterial).toHaveBeenCalledTimes(1)
    expect(disposeGeometry).toHaveBeenCalledTimes(1)
  })

  it('releases render lists and the WebGL context after renderer disposal', () => {
    const disposeRenderLists = vi.fn()
    const disposeRenderer = vi.fn()
    const forceContextLoss = vi.fn()

    disposeWebGLRenderer({
      renderLists: { dispose: disposeRenderLists },
      dispose: disposeRenderer,
      forceContextLoss
    } as never)

    expect(disposeRenderLists).toHaveBeenCalledOnce()
    expect(disposeRenderer).toHaveBeenCalledOnce()
    expect(forceContextLoss).toHaveBeenCalledOnce()
  })
})
