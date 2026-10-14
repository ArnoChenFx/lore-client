import { describe, expect, it } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { LazyViewBoundary } from './LazyViewBoundary'

describe('LazyViewBoundary', () => {
  it('renders the lazily loaded view when it is available', () => {
    const html = renderToStaticMarkup(
      <LazyViewBoundary>
        <span>ready</span>
      </LazyViewBoundary>
    )

    expect(html).toBe('<span>ready</span>')
  })

  it('hides only the failed view so a missing chunk cannot unmount the application', () => {
    const failedState = LazyViewBoundary.getDerivedStateFromError()
    expect(failedState).toEqual({ failed: true })

    const boundary = new LazyViewBoundary({ children: <span>ready</span> })
    boundary.state = failedState

    expect(boundary.render()).toBeNull()
  })
})
