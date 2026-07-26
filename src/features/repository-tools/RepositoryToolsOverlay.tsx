import { RepositoryToolsDialog } from './components/RepositoryToolsDialog'
import type { RepositoryToolsController } from './types'

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
  return <RepositoryToolsDialog {...controller.dialogProps} />
}
