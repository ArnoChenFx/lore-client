import { describe, expect, it } from 'vitest'

import { binaryPreviewKind, decodeBinaryPreviewBase64, formatPreviewBytes } from './binaryPreview'

describe('binary preview formats', () => {
  it('recognizes media, archives, fonts, and engine assets across path styles and casing', () => {
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
    expect(binaryPreviewKind('Content/Textures/Sky.DDS')).toBe('image')
    expect(binaryPreviewKind('Content/Textures/Sky.ktx2')).toBe('texture')
    expect(binaryPreviewKind('Content/Textures/Lighting.exr')).toBe('image')
    expect(binaryPreviewKind('Audio/Theme.ogg')).toBe('audio')
    expect(binaryPreviewKind('Build/Game.pak')).toBe('archive')
    expect(binaryPreviewKind('Build/client.bundle')).toBe('archive')
    expect(binaryPreviewKind('Build/client.assetbundle')).toBe('archive')
    expect(binaryPreviewKind('Fonts/Interface.otf')).toBe('font')
    expect(binaryPreviewKind('Content/Map.umap')).toBe('asset')
    expect(binaryPreviewKind('Assets/resources.assets')).toBe('asset')
    expect(binaryPreviewKind('Scenes/Main.res')).toBe('asset')
    expect(binaryPreviewKind('Art/Hero.blend')).toBe('asset')
  })

  it('rejects SVG, unknown binary formats, and paths without extensions', () => {
    expect(binaryPreviewKind('Images/vector.svg')).toBeNull()
    expect(binaryPreviewKind('Content/Map.unknown')).toBeNull()
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
