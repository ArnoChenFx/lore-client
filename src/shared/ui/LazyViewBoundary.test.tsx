import { describe, expect, it } from 'bun:test'

import { lazy, type ComponentType, type LazyExoticComponent, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { t } from '../../i18n'
import { LazyViewBoundary } from './LazyViewBoundary'

interface TestViewProps {
  label: string
}

function TestView({ label }: TestViewProps) {
  return <span>{label}</span>
}

function loadTestView() {
  return Promise.resolve({ default: TestView })
}

function loadRemountedView() {
  return Promise.resolve({ default: TestView })
}

function loadFailingView(): Promise<{ default: typeof TestView }> {
  return Promise.reject(new Error('chunk failed to load'))
}

interface RetriedState {
  failed: boolean
  View: LazyExoticComponent<ComponentType<TestViewProps>>
}

describe('LazyViewBoundary', () => {
  it('renders the lazily loaded view with the current props', () => {
    const boundary = new LazyViewBoundary<TestViewProps>({ load: loadTestView, viewProps: { label: 'ready' } })

    const suspense = boundary.render() as ReactElement<{ children: ReactElement<TestViewProps> }>
    expect(suspense.props.children.props).toEqual({ label: 'ready' })
  })

  it('shows a visible error with retry instead of an empty region after a failure', () => {
    const boundary = new LazyViewBoundary<TestViewProps>({ load: loadTestView, viewProps: { label: 'ready' } })
    boundary.state = { ...boundary.state, ...LazyViewBoundary.getDerivedStateFromError() }

    const html = renderToStaticMarkup(boundary.render())

    expect(html).toContain('role="alert"')
    expect(html).toContain(t('lazyViewUnavailable'))
    expect(html).toContain(t('retry'))
    expect(html).not.toContain('dialog-backdrop')
  })

  it('shows dialog failures with a close action so the overlay cannot trap the user', () => {
    const boundary = new LazyViewBoundary<TestViewProps>({
      load: loadTestView,
      viewProps: { label: 'ready' },
      variant: 'dialog',
      onDismiss: () => undefined
    })
    boundary.state = { ...boundary.state, ...LazyViewBoundary.getDerivedStateFromError() }

    const html = renderToStaticMarkup(boundary.render())

    expect(html).toContain('dialog-backdrop')
    expect(html).toContain('role="alertdialog"')
    expect(html).toContain(t('close'))
    expect(html).toContain(t('retry'))
  })

  it('recreates the lazy view when retry is requested after a failure', () => {
    const boundary = new LazyViewBoundary<TestViewProps>({ load: loadTestView, viewProps: { label: 'ready' } })
    const failedView = boundary.state.View
    boundary.state = { ...boundary.state, failed: true }
    const requestedStates: RetriedState[] = []
    boundary.setState = (update: unknown) => {
      requestedStates.push(update as RetriedState)
    }
    const failure = boundary.render() as ReactElement<{ onRetry: () => void }>

    failure.props.onRetry()

    const [retried] = requestedStates
    expect(retried?.failed).toBe(false)
    expect(retried?.View).not.toBe(failedView)
  })

  it('keeps a healthy view mounted when the reset key changes to another file', () => {
    const view = lazy(loadTestView)

    const next = LazyViewBoundary.getDerivedStateFromProps(
      { load: loadTestView, viewProps: { label: 'b' }, resetKey: 'b.ts' },
      { View: view, load: loadTestView, failed: false, resetKey: 'a.ts' }
    )

    expect(next).toEqual({ resetKey: 'b.ts' })
  })

  it('replaces the lazy view when the loader changes so one slot can host another view', () => {
    const view = lazy(loadTestView)
    const loadOtherView = () => Promise.resolve({ default: TestView })

    const next = LazyViewBoundary.getDerivedStateFromProps(
      { load: loadOtherView, viewProps: { label: 'a' }, resetKey: 'a.ts' },
      { View: view, load: loadTestView, failed: false, resetKey: 'a.ts' }
    )

    expect(next?.load).toBe(loadOtherView)
    expect(next?.View).not.toBe(view)
  })

  it('clears a failed view and recreates its lazy import when the reset key changes', () => {
    const failedView = lazy(loadTestView)

    const next = LazyViewBoundary.getDerivedStateFromProps(
      { load: loadTestView, viewProps: { label: 'b' }, resetKey: 'b.ts' },
      { View: failedView, load: loadTestView, failed: true, resetKey: 'a.ts' }
    )

    expect(next?.failed).toBe(false)
    expect(next?.resetKey).toBe('b.ts')
    expect(next?.View).toBeDefined()
    expect(next?.View).not.toBe(failedView)
  })

  it('reuses the lazy view for the same loader so a remounted view does not suspend again', () => {
    const first = new LazyViewBoundary<TestViewProps>({ load: loadRemountedView, viewProps: { label: 'a' } })
    const remounted = new LazyViewBoundary<TestViewProps>({ load: loadRemountedView, viewProps: { label: 'b' } })

    expect(remounted.state.View).toBe(first.state.View)
  })

  it('does not reuse a view whose import failed when a boundary mounts again', () => {
    const failing = new LazyViewBoundary<TestViewProps>({ load: loadFailingView, viewProps: { label: 'a' } })
    const failedView = failing.state.View

    failing.componentDidCatch(new Error('chunk failed to load'))
    const retry = new LazyViewBoundary<TestViewProps>({ load: loadFailingView, viewProps: { label: 'a' } })

    expect(retry.state.View).not.toBe(failedView)
  })

  it('keeps a failure in place while the reset key is unchanged', () => {
    const view = lazy(loadTestView)

    const next = LazyViewBoundary.getDerivedStateFromProps(
      { load: loadTestView, viewProps: { label: 'a' }, resetKey: 'a.ts' },
      { View: view, load: loadTestView, failed: true, resetKey: 'a.ts' }
    )

    expect(next).toBeNull()
  })
})
