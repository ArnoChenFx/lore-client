import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'

import i18n from '../../i18n'
import type { BinaryDiffPreview as BinaryDiffPreviewData } from '../../types'
import { BinaryDiffPreview as BinaryDiffPreviewView } from './BinaryDiffPreview'
import { createBinaryDiffPreviewView } from './binaryPreviewData'
import { copyPdfData } from './PdfCanvasPreview'

/** 测试继续使用稳定 IPC DTO，统一在真实组件边界转换成非枚举视图。 */
function BinaryDiffPreview({
  preview,
  ...props
}: {
  fileName: string
  preview: BinaryDiffPreviewData | null
  loading: boolean
  error: string | null
  size?: number
}) {
  return <BinaryDiffPreviewView {...props} preview={preview ? createBinaryDiffPreviewView(preview) : null} />
}

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
            size: 1,
            contentState: 'available'
          },
          after: {
            path: 'Content/Sky.png',
            kind: 'image',
            mimeType: 'image/png',
            data: new Uint8Array([1]),
            size: 1,
            contentState: 'available'
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
            size: 5,
            contentState: 'available'
          }
        }}
      />
    )

    expect(html).toContain('<canvas')
    expect(html).not.toContain('Parsing PDF')
    expect(html).not.toContain('is-spinning')
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
            size: 1,
            contentState: 'available'
          }
        }}
      />
    )

    // Canvas 挂在 React 不管理的宿主里，静态渲染只验证预览壳层。
    expect(html).toContain('class="binary-diff-preview__card is-model"')
    expect(html).toContain('binary-diff-preview__model-host')
    expect(html).not.toContain('Parsing 3D model')
    expect(html).not.toContain('is-spinning')
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
            size: 28,
            contentState: 'available'
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
            size: 4,
            contentState: 'available'
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
            contentState: 'available',
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
    expect(html).not.toContain('Transcoding KTX2 texture')
    expect(html).not.toContain('is-spinning')
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
            size: 4,
            contentState: 'available'
          }
        }}
      />
    )

    expect(html).not.toContain('Parsing font')
    expect(html).not.toContain('is-spinning')
    expect(html).not.toContain('data:font/otf')
  })

  it('renders no transition content while preview data is loading', () => {
    const html = renderToStaticMarkup(<BinaryDiffPreview fileName="Hero.fbx" loading error={null} preview={null} />)

    expect(html).toBe('')
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
            contentState: 'available',
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
            contentState: 'available',
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

  it('combines an editor thumbnail with structured asset metadata without a data URL', () => {
    const html = renderToStaticMarkup(
      <BinaryDiffPreview
        fileName="Hero.blend"
        loading={false}
        error={null}
        preview={{
          after: {
            path: 'Art/Hero.blend',
            kind: 'asset',
            mimeType: 'image/png',
            data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
            size: 512,
            contentState: 'available',
            structuredPreview: {
              type: 'assetMetadata',
              format: 'Blender',
              facts: [{ key: 'version', value: '500' }],
              warningCodes: []
            }
          }
        }}
      />
    )

    expect(html).toContain('binary-diff-preview__asset-layout has-thumbnail')
    expect(html).toContain('binary-diff-preview__asset-thumbnail')
    expect(html).toContain('Blender')
    expect(html).toContain('Version')
    expect(html.indexOf('binary-diff-preview__structured-viewer')).toBeLessThan(
      html.indexOf('binary-diff-preview__asset-thumbnail')
    )
    expect(html).not.toContain('data:image/png')
  })

  it('explains when an Unreal editor thumbnail is unavailable without guessing asset images', () => {
    const html = renderToStaticMarkup(
      <BinaryDiffPreview
        fileName="World.umap"
        loading={false}
        error={null}
        preview={{
          after: {
            path: 'Content/World.umap',
            kind: 'asset',
            mimeType: 'application/x-unreal-asset',
            data: new Uint8Array(),
            size: 512,
            contentState: 'available',
            structuredPreview: {
              type: 'assetMetadata',
              format: 'Unreal map package',
              facts: [],
              warningCodes: ['unrealEmbeddedThumbnailUnavailable']
            }
          }
        }}
      />
    )

    expect(html).toContain('has no validated editor thumbnail')
    expect(html).toContain('class="binary-diff-preview__asset-layout"')
    expect(html).not.toContain('binary-diff-preview__asset-layout has-thumbnail')
    expect(html).not.toContain('binary-diff-preview__asset-thumbnail')
  })

  it('copies PDF Raw IPC data into an independent byte array', () => {
    const source = new Uint8Array([37, 80, 68, 70])
    const copy = copyPdfData(source)
    expect(Array.from(copy)).toEqual([37, 80, 68, 70])
    expect(copy).not.toBe(source)
  })

  it('renders only the file size change when an asset exceeds the preview limit', () => {
    const html = renderToStaticMarkup(
      <BinaryDiffPreview
        fileName="World.umap"
        loading={false}
        error={null}
        preview={{
          before: {
            path: 'Content/World.umap',
            kind: 'asset',
            mimeType: 'application/x-unreal-asset',
            data: new Uint8Array(),
            size: 24 * 1024 * 1024,
            contentState: 'tooLarge'
          },
          after: {
            path: 'Content/World.umap',
            kind: 'asset',
            mimeType: 'application/x-unreal-asset',
            data: new Uint8Array(),
            size: 30 * 1024 * 1024,
            contentState: 'tooLarge'
          }
        }}
      />
    )

    expect(html).toContain('Asset exceeds the embedded preview limit')
    expect(html).toContain('24.0 MB')
    expect(html).toContain('30.0 MB')
    expect(html).toContain('+6.0 MB')
    expect(html).toContain('binary-diff-preview__size-delta is-increase')
    expect(html).toContain('lucide-file-exclamation-point')
    expect(html).not.toContain('binary-diff-preview__card')
  })

  it('marks a negative oversized asset size change as a decrease', () => {
    const html = renderToStaticMarkup(
      <BinaryDiffPreview
        fileName="World.umap"
        loading={false}
        error={null}
        preview={{
          before: {
            path: 'Content/World.umap',
            kind: 'asset',
            mimeType: 'application/x-unreal-asset',
            data: new Uint8Array(),
            size: 30 * 1024 * 1024,
            contentState: 'tooLarge'
          },
          after: {
            path: 'Content/World.umap',
            kind: 'asset',
            mimeType: 'application/x-unreal-asset',
            data: new Uint8Array(),
            size: 24 * 1024 * 1024,
            contentState: 'tooLarge'
          }
        }}
      />
    )

    expect(html).toContain('−6.0 MB')
    expect(html).toContain('binary-diff-preview__size-delta is-decrease')
  })

  it('uses a distinct message for an unsupported binary size change', () => {
    const html = renderToStaticMarkup(
      <BinaryDiffPreview
        fileName="OnlineFramework.archive"
        loading={false}
        error={null}
        preview={{
          before: {
            path: 'src/OnlineFramework.archive',
            kind: 'binary',
            mimeType: 'application/octet-stream',
            data: new Uint8Array(),
            size: 8 * 1024,
            contentState: 'unsupported'
          },
          after: {
            path: 'src/OnlineFramework.archive',
            kind: 'binary',
            mimeType: 'application/octet-stream',
            data: new Uint8Array(),
            size: 9 * 1024,
            contentState: 'unsupported'
          }
        }}
      />
    )

    expect(html).toContain('This binary type does not support embedded preview')
    expect(html).toContain('8.0 KB')
    expect(html).toContain('9.0 KB')
    expect(html).toContain('+1.0 KB')
    expect(html).toContain('binary-diff-preview__size-delta is-increase')
    expect(html).toContain('lucide-binary')
    expect(html).not.toContain('lucide-file-exclamation-point')
    expect(html).not.toContain('Asset exceeds the embedded preview limit')
  })
})
