import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { CheckboxInput, NumberInput, SelectInput, TextButton, TextInput } from './ControlPrimitives'
import { IconButton } from './IconButton'

describe('ControlPrimitives', () => {
  it('provides stable types and shared semantic classes for text and number inputs', () => {
    const html = renderToStaticMarkup(
      <>
        <TextInput aria-label="名称" defaultValue="main" />
        <NumberInput aria-label="深度" min={1} max={32} defaultValue={4} />
      </>
    )

    expect(html).toContain('type="text"')
    expect(html).toContain('class="control-input tool-input"')
    expect(html).toContain('type="number"')
    expect(html).toContain('control-input--numeric')
  })

  it('keeps the native select and hides its decorative arrow from the accessibility tree', () => {
    const html = renderToStaticMarkup(
      <SelectInput aria-label="分支" defaultValue="main">
        <option value="main">main</option>
      </SelectInput>
    )

    expect(html).toContain('class="control-select tool-select"')
    expect(html).toContain('<select')
    expect(html).toContain('aria-hidden="true"')
  })

  it('shares checkbox semantics while preserving native checked and disabled states', () => {
    const html = renderToStaticMarkup(
      <CheckboxInput aria-label="包含传递依赖" defaultChecked disabled className="dependency-checkbox" />
    )

    expect(html).toContain('type="checkbox"')
    expect(html).toContain('class="control-checkbox tool-checkbox dependency-checkbox"')
    expect(html).toContain('checked=""')
    expect(html).toContain('disabled=""')
  })

  it('prevents text buttons from submitting forms by default and uses variants for action hierarchy', () => {
    const neutralHtml = renderToStaticMarkup(<TextButton>刷新</TextButton>)
    const primaryHtml = renderToStaticMarkup(<TextButton variant="primary">应用</TextButton>)
    const dangerHtml = renderToStaticMarkup(<TextButton variant="danger">清理</TextButton>)

    expect(neutralHtml).toContain('type="button"')
    expect(neutralHtml).toContain('class="control-button tool-button"')
    expect(primaryHtml).toContain('is-primary')
    expect(dangerHtml).toContain('is-danger')
  })

  it('uses the accessible icon button name as its default hover tooltip', () => {
    const html = renderToStaticMarkup(<IconButton icon={<span>×</span>} label="关闭" />)

    expect(html).toContain('type="button"')
    expect(html).toContain('class="control-icon-button icon-button"')
    expect(html).toContain('aria-label="关闭"')
    expect(html).toContain('title="关闭"')
    expect(html).toContain('aria-hidden="true"')
  })
})
