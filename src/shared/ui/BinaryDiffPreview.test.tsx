import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'

import i18n from '../../i18n'
import { BinaryDiffPreview } from './BinaryDiffPreview'
import { decodePdfBase64 } from './PdfCanvasPreview'

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
            dataBase64: 'AA==',
            size: 1
          },
          after: {
            path: 'Content/Sky.png',
            kind: 'image',
            mimeType: 'image/png',
            dataBase64: 'AQ==',
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
    expect(html).toContain('data:image/png;base64,AA==')
    expect(html).toContain('data:image/png;base64,AQ==')
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
            dataBase64: 'JVBERg==',
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
            dataBase64: 'AA==',
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
    const csvBase64 = btoa('name,value\nalpha,1\nbeta,2\n')
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
            dataBase64: csvBase64,
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

  it('decodes PDF Base64 into an independent byte array', () => {
    expect(Array.from(decodePdfBase64('JVBERg=='))).toEqual([37, 80, 68, 70])
  })
})
