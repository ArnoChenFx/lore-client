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
        structuredPreview: null
      },
      new Uint8Array([1, 2, 3, 4])
    )

    const preview = decodeBinaryFilePreviewEnvelope(envelope)

    expect(preview.path).toBe('Content/Sky.png')
    expect(Array.from(preview.data)).toEqual([1, 2, 3, 4])
    expect(preview.data.buffer).toBe(envelope)
  })

  it('rejects an envelope whose metadata length exceeds the response', () => {
    const envelope = new ArrayBuffer(4)
    new DataView(envelope).setUint32(0, 100, true)

    expect(() => decodeBinaryFilePreviewEnvelope(envelope)).toThrow('metadata length is invalid')
  })
})
