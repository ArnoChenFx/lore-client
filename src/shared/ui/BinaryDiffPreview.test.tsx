import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'

import i18n from '../../i18n'
import { BinaryDiffPreview } from './BinaryDiffPreview'
import { copyPdfData } from './PdfCanvasPreview'

describe('binary diff preview', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US')
  })

  it('renders both before and after versions of a modified image', () => {
    const html = renderToStaticMarkup(
      <BinaryDiffPreview
        fileName="Sky.png"
        loading={false}
        error={null}
        preview={{
          before: {
            path: 'Content/Sky.png',
            kind: 'image',
            mimeType: 'image/png',
            data: new Uint8Array([0]),
            size: 1
          },
          after: {
            path: 'Content/Sky.png',
            kind: 'image',
            mimeType: 'image/png',
            data: new Uint8Array([1]),
            size: 1
          }
        }}
      />
    )

    expect(html).toContain('Before')
    expect(html).toContain('After')
    expect(html).toContain('class="binary-diff-preview has-comparison"')
    // 旧 `.binary-preview` 属于另一块演示画布，不能让真实 Diff 复用并覆盖其布局。
    expect(html).not.toContain('class="binary-preview')
    expect(html).not.toContain('data:image/png')
  })

  it('renders PDFs on an in-app canvas without a WebView2-blocked iframe', () => {
    const html = renderToStaticMarkup(
      <BinaryDiffPreview
        fileName="Design.pdf"
        loading={false}
        error={null}
        preview={{
          after: {
            path: 'Docs/Design.pdf',
            kind: 'pdf',
            mimeType: 'application/pdf',
            data: new Uint8Array([37, 80, 68, 70]),
            size: 5
          }
        }}
      />
    )

    expect(html).toContain('<canvas')
    expect(html).toContain('Parsing PDF')
    expect(html).toContain('PDF previous page')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('data:application/pdf')
  })

  it('uses an in-app surface for 3D models without data URLs or iframes', () => {
    const html = renderToStaticMarkup(
      <BinaryDiffPreview
        fileName="Hero.fbx"
        loading={false}
        error={null}
        preview={{
          after: {
            path: 'Content/Meshes/Hero.fbx',
            kind: 'model',
            mimeType: 'model/fbx',
            data: new Uint8Array([0]),
            size: 1
          }
        }}
      />
    )

    // Canvas 挂在 React 不管理的宿主里，静态渲染只验证预览壳层。
    expect(html).toContain('Parsing 3D model')
    expect(html).toContain('class="binary-diff-preview__card is-model"')
    expect(html).toContain('binary-diff-preview__model-host')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('data:model/fbx')
  })

  it('uses an in-app table for CSV without a data URL', () => {
    const csvData = new TextEncoder().encode('name,value\nalpha,1\nbeta,2\n')
    const html = renderToStaticMarkup(
      <BinaryDiffPreview
        fileName="Stats.csv"
        loading={false}
        error={null}
        preview={{
          after: {
            path: 'Data/Stats.csv',
            kind: 'csv',
            mimeType: 'text/csv',
            data: csvData,
            size: 28
          }
        }}
      />
    )

    expect(html).toContain('<table')
    expect(html).toContain('class="binary-diff-preview__card is-csv"')
    expect(html).toContain('name')
    expect(html).toContain('alpha')
    expect(html).not.toContain('data:text/csv')
  })

  it('renders audio with a non-autoplay in-memory source', () => {
    const html = renderToStaticMarkup(
      <BinaryDiffPreview
        fileName="Theme.ogg"
        loading={false}
        error={null}
        preview={{
          after: {
            path: 'Audio/Theme.ogg',
            kind: 'audio',
            mimeType: 'audio/ogg',
            data: new TextEncoder().encode('OggS'),
            size: 4
          }
        }}
      />
    )

    expect(html).toContain('<audio controls="" preload="metadata"')
    expect(html).not.toContain('src=')
    expect(html).not.toContain(' autoplay=')
  })

  it('renders the KTX2 canvas shell without external texture URLs', () => {
    const html = renderToStaticMarkup(
      <BinaryDiffPreview
        fileName="Sky.ktx2"
        loading={false}
        error={null}
        preview={{
          after: {
            path: 'Textures/Sky.ktx2',
            kind: 'texture',
            mimeType: 'image/ktx2',
            data: new Uint8Array([0xab, 0x4b, 0x54, 0x58]),
            size: 12,
            structuredPreview: {
              type: 'assetMetadata',
              format: 'KTX2',
              facts: [{ key: 'width', value: '1024' }],
              warningCodes: []
            }
          }
        }}
      />
    )

    expect(html).toContain('binary-diff-preview__texture-host')
    expect(html).toContain('Transcoding KTX2 texture')
    expect(html).not.toContain('https://')
  })

  it('renders a lifecycle-bound font preview shell without a font URL', () => {
    const html = renderToStaticMarkup(
      <BinaryDiffPreview
        fileName="Interface.otf"
        loading={false}
        error={null}
        preview={{
          after: {
            path: 'Fonts/Interface.otf',
            kind: 'font',
            mimeType: 'font/otf',
            data: new TextEncoder().encode('OTTO'),
            size: 4
          }
        }}
      />
    )

    expect(html).toContain('Parsing font')
    expect(html).not.toContain('data:font/otf')
  })

  it('renders archive entries from Rust structured metadata without extracting files', () => {
    const html = renderToStaticMarkup(
      <BinaryDiffPreview
        fileName="Game.pak"
        loading={false}
        error={null}
        preview={{
          after: {
            path: 'Build/Game.pak',
            kind: 'archive',
            mimeType: 'application/x-pak',
            data: new Uint8Array(),
            size: 128,
            structuredPreview: {
              type: 'archive',
              format: 'Quake PAK',
              totalEntries: 1,
              truncated: false,
              entries: [{ path: 'maps/start.bsp', kind: 'file', size: 64 }],
              facts: [],
              warningCodes: []
            }
          }
        }}
      />
    )

    expect(html).toContain('Quake PAK')
    expect(html).toContain('maps/start.bsp')
    expect(html).toContain('1 entry')
    expect(html).not.toContain('data:application/x-pak')
  })

  it('renders engine metadata as localized semantic fields', () => {
    const html = renderToStaticMarkup(
      <BinaryDiffPreview
        fileName="Hero.blend"
        loading={false}
        error={null}
        preview={{
          after: {
            path: 'Art/Hero.blend',
            kind: 'asset',
            mimeType: 'application/x-blender',
            data: new Uint8Array(),
            size: 256,
            structuredPreview: {
              type: 'assetMetadata',
              format: 'Blender',
              facts: [
                { key: 'version', value: '400' },
                { key: 'meshCount', value: '3' }
              ],
              warningCodes: []
            }
          }
        }}
      />
    )

    expect(html).toContain('Blender')
    expect(html).toContain('Version')
    expect(html).toContain('Meshes')
    expect(html).not.toContain('data:application/x-blender')
  })

  it('copies PDF Raw IPC data into an independent byte array', () => {
    const source = new Uint8Array([37, 80, 68, 70])
    const copy = copyPdfData(source)
    expect(Array.from(copy)).toEqual([37, 80, 68, 70])
    expect(copy).not.toBe(source)
  })
})
