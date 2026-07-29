import { describe, expect, it } from 'vitest'

import { decodeBinaryFilePreviewEnvelope } from './lore'

function createEnvelope(metadata: object, payload: Uint8Array): ArrayBuffer {
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata))
  const envelope = new Uint8Array(4 + metadataBytes.byteLength + payload.byteLength)
  new DataView(envelope.buffer).setUint32(0, metadataBytes.byteLength, true)
  envelope.set(metadataBytes, 4)
  envelope.set(payload, 4 + metadataBytes.byteLength)
  return envelope.buffer
}

describe('binary preview Raw IPC envelope', () => {
  it('keeps the payload as a view over the original ArrayBuffer', () => {
    const envelope = createEnvelope(
      {
        path: 'Content/Sky.png',
        kind: 'image',
        mimeType: 'image/png',
        size: 4,
        contentState: 'available',
        structuredPreview: null
      },
      new Uint8Array([1, 2, 3, 4])
    )

    const preview = decodeBinaryFilePreviewEnvelope(envelope)

    expect(preview.path).toBe('Content/Sky.png')
    expect(preview.contentState).toBe('available')
    expect(Array.from(preview.data)).toEqual([1, 2, 3, 4])
    expect(preview.data.buffer).toBe(envelope)
  })

  it('accepts a metadata-only envelope for an oversized asset', () => {
    const envelope = createEnvelope(
      {
        path: 'Content/World.umap',
        kind: 'asset',
        mimeType: 'application/x-unreal-asset',
        size: 24 * 1024 * 1024,
        contentState: 'tooLarge',
        structuredPreview: null
      },
      new Uint8Array()
    )

    const preview = decodeBinaryFilePreviewEnvelope(envelope)

    expect(preview.contentState).toBe('tooLarge')
    expect(preview.size).toBe(24 * 1024 * 1024)
    expect(preview.data).toHaveLength(0)
  })

  it('accepts a metadata-only envelope for an unsupported binary', () => {
    const envelope = createEnvelope(
      {
        path: 'Content/OnlineFramework.archive',
        kind: 'binary',
        mimeType: 'application/octet-stream',
        size: 8192,
        contentState: 'unsupported',
        structuredPreview: null
      },
      new Uint8Array()
    )

    const preview = decodeBinaryFilePreviewEnvelope(envelope)

    expect(preview.kind).toBe('binary')
    expect(preview.contentState).toBe('unsupported')
    expect(preview.size).toBe(8192)
    expect(preview.data).toHaveLength(0)
  })

  it('accepts a metadata-only envelope for a disabled binary Diff', () => {
    const envelope = createEnvelope(
      {
        path: 'Content/Images/Preview.png',
        kind: 'image',
        mimeType: 'image/png',
        size: 8192,
        contentState: 'metadataOnly',
        structuredPreview: null
      },
      new Uint8Array()
    )

    const preview = decodeBinaryFilePreviewEnvelope(envelope)
    expect(preview.contentState).toBe('metadataOnly')
    expect(preview.size).toBe(8192)
    expect(preview.data).toHaveLength(0)
  })

  it('rejects an envelope whose metadata length exceeds the response', () => {
    const envelope = new ArrayBuffer(4)
    new DataView(envelope).setUint32(0, 100, true)

    expect(() => decodeBinaryFilePreviewEnvelope(envelope)).toThrow('metadata length is invalid')
  })
})
