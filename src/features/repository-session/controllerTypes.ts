import type { NavigationView, OperationDetail, Repository, ToastMessage } from '../../types'

/** 跨领域控制器使用的通知边界，不暴露 App 的 Toast 状态实现。 */
export type AppNotify = (title: string, detail: string, tone?: ToastMessage['tone']) => void

/**
 * 已绑定当前仓库会话的写操作入口。
 *
 * 调用者只描述任务、完成详情和目标视图；串行门闩、快照刷新和冲突恢复由仓库会话层
 * 统一实现。
 */
export type RunRepositoryMutation = (
  labelKey: string,
  task: (repository: Repository) => Promise<unknown>,
  successDetail: string | OperationDetail,
  nextView?: NavigationView
) => Promise<boolean>
