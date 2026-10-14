import type { ComponentProps } from 'react'

import { OperationCenter } from '../features/operations'
import {
  CloneDialog,
  InitializeRepositoryDialog,
  RemoteAuthenticationDialog,
  ServerDialog
} from '../features/repository-session'
import { LazyViewBoundary } from '../shared/ui'
import { AboutDialog } from './components/AboutDialog'
import { CommandPalette } from './components/CommandPalette'
import { SearchDialog } from './components/SearchDialog'
import type { SettingsDialog } from './components/SettingsDialog'
import type { UpdateDialog } from './components/UpdateDialog'

/*
 * 设置页与更新说明各自带有独立依赖：更新说明需要 react-markdown 解析链，只在检测到新版本
 * 时出现；设置页只在用户打开时出现。两者都延迟加载，不进入每次启动都要解析的主包。
 */
const loadSettingsDialog = () =>
  import('./components/SettingsDialog').then((module) => ({ default: module.SettingsDialog }))
const loadUpdateDialog = () => import('./components/UpdateDialog').then((module) => ({ default: module.UpdateDialog }))

interface AppGlobalOverlaysProps {
  commandPalette: ComponentProps<typeof CommandPalette> | null
  initialization: ComponentProps<typeof InitializeRepositoryDialog> | null
  server: ComponentProps<typeof ServerDialog> | null
  clone: ComponentProps<typeof CloneDialog> | null
  settings: ComponentProps<typeof SettingsDialog> | null
  search: ComponentProps<typeof SearchDialog> | null
  operations: ComponentProps<typeof OperationCenter> | null
  about: ComponentProps<typeof AboutDialog> | null
  update: ComponentProps<typeof UpdateDialog> | null
  remoteAuthentication: ComponentProps<typeof RemoteAuthenticationDialog> | null
}

/**
 * 应用级弹层组合边界。
 *
 * 可见性和业务动作由 App 控制器决定；本组件只负责把已经准备好的稳定属性映射为弹层，
 * 保证顶层返回树不再混合服务器、设置、更新和操作中心等无关领域的 JSX。
 */
export function AppGlobalOverlays({
  commandPalette,
  initialization,
  server,
  clone,
  settings,
  search,
  operations,
  about,
  update,
  remoteAuthentication
}: AppGlobalOverlaysProps) {
  return (
    <>
      {commandPalette && <CommandPalette {...commandPalette} />}
      {initialization && <InitializeRepositoryDialog {...initialization} />}
      {server && <ServerDialog {...server} />}
      {clone && <CloneDialog {...clone} />}
      {settings && (
        <LazyViewBoundary
          load={loadSettingsDialog}
          viewProps={settings}
          onDismiss={settings.onClose}
          variant="dialog"
        />
      )}
      {search && <SearchDialog {...search} />}
      {operations && <OperationCenter {...operations} />}
      {about && <AboutDialog {...about} />}
      {update && (
        <LazyViewBoundary load={loadUpdateDialog} viewProps={update} onDismiss={update.onClose} variant="dialog" />
      )}
      {remoteAuthentication && <RemoteAuthenticationDialog {...remoteAuthentication} />}
    </>
  )
}
