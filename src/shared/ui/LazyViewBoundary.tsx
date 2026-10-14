import { TriangleAlert } from 'lucide-react'
import { Component, lazy, Suspense, useId, type ComponentType, type LazyExoticComponent } from 'react'
import { useTranslation } from 'react-i18next'

import { logError } from '../../services/logging'
import { TextButton } from './ControlPrimitives'

export interface LazyViewModule<P extends object> {
  default: ComponentType<P>
}

export interface LazyViewBoundaryProps<P extends object> {
  /** 创建或重试 `React.lazy` 时使用；复用已失败的实例只会立即再次失败。引用变化时会替换视图，同一位置可切换到另一个视图。 */
  load: () => Promise<LazyViewModule<P>>
  viewProps: P
  /** 变化时清除失败状态（例如切换文件）。必须是字符串等原始值，否则每次渲染都会被视为变化。 */
  resetKey?: string
  /** 弹层必须提供关闭入口，否则失败状态会把用户困在遮罩中。 */
  onDismiss?: () => void
  /** `dialog` 会包裹在弹层遮罩中，与各弹层的定位和层级保持一致。 */
  variant?: 'panel' | 'dialog'
}

interface LazyViewFailureState {
  failed: boolean
}

interface LazyViewBoundaryState<P extends object> extends LazyViewFailureState {
  View: LazyExoticComponent<ComponentType<P>>
  load: LazyViewBoundaryProps<P>['load']
  resetKey: string | undefined
}

/**
 * 包裹按需加载的视图。导入或渲染失败时显示可见的错误与重试入口，而不是留下永久空白；
 * 切换 `resetKey` 会清除失败状态，使下一个文件或路径重新尝试渲染。
 * 浏览器同样缓存失败的模块请求，因此动态导入失败后重试无法重新下载，需重启应用；重试主要恢复渲染错误。
 */
export class LazyViewBoundary<P extends object> extends Component<LazyViewBoundaryProps<P>, LazyViewBoundaryState<P>> {
  constructor(props: LazyViewBoundaryProps<P>) {
    super(props)
    this.state = { View: lazy(props.load), load: props.load, failed: false, resetKey: props.resetKey }
  }

  static getDerivedStateFromError(): LazyViewFailureState {
    return { failed: true }
  }

  static getDerivedStateFromProps<Q extends object>(
    props: LazyViewBoundaryProps<Q>,
    state: LazyViewBoundaryState<Q>
  ): Partial<LazyViewBoundaryState<Q>> | null {
    const loaderChanged = props.load !== state.load
    if (!loaderChanged && props.resetKey === state.resetKey) return null
    if (!loaderChanged && !state.failed) return { resetKey: props.resetKey }
    return { load: props.load, resetKey: props.resetKey, failed: false, View: lazy(props.load) }
  }

  componentDidCatch(error: unknown) {
    logError('lazy-view', error)
  }

  private readonly retry = () => {
    this.setState({ failed: false, View: lazy(this.props.load) })
  }

  render() {
    if (this.state.failed) {
      return (
        <LazyViewFailure
          variant={this.props.variant ?? 'panel'}
          onRetry={this.retry}
          onDismiss={this.props.onDismiss}
        />
      )
    }
    const { View } = this.state
    return (
      <Suspense fallback={null}>
        <View {...this.props.viewProps} />
      </Suspense>
    )
  }
}

interface LazyViewFailureProps {
  variant: 'panel' | 'dialog'
  onRetry: () => void
  onDismiss?: () => void
}

function LazyViewFailure({ variant, onRetry, onDismiss }: LazyViewFailureProps) {
  const { t } = useTranslation()
  const titleId = useId()

  if (variant === 'dialog') {
    return (
      <div className="dialog-backdrop" role="presentation">
        <section className="task-dialog compact-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId}>
          <header className="task-dialog__header">
            <span className="task-dialog__mark">
              <TriangleAlert size={18} />
            </span>
            <span>
              <h2 id={titleId}>{t('lazyViewUnavailable')}</h2>
            </span>
          </header>
          <div className="task-dialog__body">
            <p>{t('lazyViewUnavailableHint')}</p>
          </div>
          <footer className="task-dialog__footer">
            {onDismiss && (
              <button type="button" onClick={onDismiss}>
                {t('close')}
              </button>
            )}
            <button type="button" className="is-primary" onClick={onRetry}>
              {t('retry')}
            </button>
          </footer>
        </section>
      </div>
    )
  }

  return (
    <div className="lazy-view-error" role="alert">
      <TriangleAlert size={27} />
      <strong>{t('lazyViewUnavailable')}</strong>
      <span>{t('lazyViewUnavailableHint')}</span>
      <TextButton variant="primary" onClick={onRetry}>
        {t('retry')}
      </TextButton>
    </div>
  )
}
