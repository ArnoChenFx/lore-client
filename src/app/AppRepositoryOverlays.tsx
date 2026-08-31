import type { ComponentProps } from 'react'

import { BranchArchiveDialog, BranchCreateDialog } from '../features/branches'
import { RepositoryToolsOverlay } from '../features/repository-tools'
import { FileHistoryDialog } from '../features/revision-inspector'
import { TagContextMenu, TagDetailsDialog, TagDialog } from '../features/tags'
import { VersionContextMenu } from '../shared/ui'

interface AppRepositoryOverlaysProps {
  branchCreate: ComponentProps<typeof BranchCreateDialog> | null
  branchArchive: ComponentProps<typeof BranchArchiveDialog> | null
  tagEditor: ComponentProps<typeof TagDialog> | null
  tagDetails: ComponentProps<typeof TagDetailsDialog> | null
  fileHistory: ComponentProps<typeof FileHistoryDialog> | null
  repositoryTools: ComponentProps<typeof RepositoryToolsOverlay>
  versionMenu: ComponentProps<typeof VersionContextMenu> | null
  tagMenu: ComponentProps<typeof TagContextMenu> | null
}

/**
 * 组合依附于当前仓库对象的弹层。
 *
 * 各领域控制器仍拥有状态与写操作，本组件只消费已经准备好的窄化属性；这让 App 的
 * 全局弹层与仓库对象弹层分层，同时避免用 Context 隐藏跨领域依赖。
 */
export function AppRepositoryOverlays({
  branchCreate,
  branchArchive,
  tagEditor,
  tagDetails,
  fileHistory,
  repositoryTools,
  versionMenu,
  tagMenu
}: AppRepositoryOverlaysProps) {
  return (
    <>
      {branchCreate && <BranchCreateDialog {...branchCreate} />}
      {branchArchive && <BranchArchiveDialog {...branchArchive} />}
      {tagEditor && <TagDialog {...tagEditor} />}
      {tagDetails && <TagDetailsDialog {...tagDetails} />}
      {fileHistory && <FileHistoryDialog {...fileHistory} />}
      <RepositoryToolsOverlay {...repositoryTools} />
      {versionMenu && <VersionContextMenu {...versionMenu} />}
      {tagMenu && <TagContextMenu {...tagMenu} />}
    </>
  )
}
