import { Component, Suspense, type ReactNode } from 'react'

import { logError } from '../../services/logging'

interface LazyViewBoundaryProps {
  children: ReactNode
}

interface LazyViewBoundaryState {
  failed: boolean
}

/**
 * 包裹 `React.lazy` 视图。动态导入失败（例如升级后旧分包已不存在）时只隐藏该视图，
 * 不让异常冒泡并卸载整个应用。React 会缓存失败的导入，因此该视图在重新加载应用前不会恢复。
 */
export class LazyViewBoundary extends Component<LazyViewBoundaryProps, LazyViewBoundaryState> {
  state: LazyViewBoundaryState = { failed: false }

  static getDerivedStateFromError(): LazyViewBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    logError('lazy-view', error)
  }

  render() {
    if (this.state.failed) return null
    return <Suspense fallback={null}>{this.props.children}</Suspense>
  }
}
