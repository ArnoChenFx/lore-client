import { describe, expect, it } from 'vitest'

import { binaryPreviewKind, decodeBinaryPreviewBase64, formatPreviewBytes } from './binaryPreview'

describe('binary preview formats', () => {
  it('recognizes common images, PDFs, textures, and 3D models across path styles and casing', () => {
    expect(binaryPreviewKind('Content\\Textures\\Sky.PNG')).toBe('image')
    expect(binaryPreviewKind('Docs/design.PdF')).toBe('pdf')
    expect(binaryPreviewKind('Images/photo.jpeg')).toBe('image')
    expect(binaryPreviewKind('Content\\Textures\\Albedo.TGA')).toBe('image')
    expect(binaryPreviewKind('Content/Textures/Normal.tif')).toBe('image')
    expect(binaryPreviewKind('Content/Meshes/Hero.FBX')).toBe('model')
    expect(binaryPreviewKind('Content/Meshes/Prop.gltf')).toBe('model')
    expect(binaryPreviewKind('Content/Meshes/Prop.glb')).toBe('model')
    expect(binaryPreviewKind('Content/Meshes/Rock.obj')).toBe('model')
    expect(binaryPreviewKind('Data\\Stats.CSV')).toBe('csv')
  })

  it('rejects SVG, generic assets, and paths without extensions', () => {
    expect(binaryPreviewKind('Images/vector.svg')).toBeNull()
    expect(binaryPreviewKind('Content/Map.umap')).toBeNull()
    expect(binaryPreviewKind('LICENSE')).toBeNull()
  })

  it('formats preview byte counts with compact units', () => {
    expect(formatPreviewBytes(0)).toBe('0 B')
    expect(formatPreviewBytes(1_536)).toBe('1.5 KB')
    expect(formatPreviewBytes(2 * 1_024 * 1_024)).toBe('2.0 MB')
  })

  it('decodes preview Base64 into an independent byte array', () => {
    expect(Array.from(decodeBinaryPreviewBase64('JVBERg=='))).toEqual([37, 80, 68, 70])
  })
})
