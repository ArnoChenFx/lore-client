import { lazy, Suspense } from 'react'

import type { RepositoryToolsController } from './types'

/*
 * 工具面板包含依赖图、诊断、认证账号等大量子面板，而绝大多数会话从不打开它。
 * 只有控制器真正给出 dialogProps 时才加载，避免它们进入每次启动都要解析的主包。
 */
const RepositoryToolsDialog = lazy(() =>
  import('./components/RepositoryToolsDialog').then((module) => ({ default: module.RepositoryToolsDialog }))
)

interface RepositoryToolsOverlayProps {
  controller: RepositoryToolsController
}

/**
 * Repository Tools 的应用级组合边界。
 *
 * App 只挂载一个控制器，不再逐项连接数十个资源和动作属性；现有 Dialog 仍保持纯展示
 * 契约，后续移动其子面板目录时不需要重新修改应用组合根。
 */
export function RepositoryToolsOverlay({ controller }: RepositoryToolsOverlayProps) {
  if (!controller.dialogProps) return null
  return (
    <Suspense fallback={null}>
      <RepositoryToolsDialog {...controller.dialogProps} />
    </Suspense>
  )
}
