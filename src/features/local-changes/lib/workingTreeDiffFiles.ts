import type { FileDiffLoadedFiles } from '@pierre/diffs'

import { t } from '../../../i18n'
import type { TextDiffFullFileTarget } from '../../../shared/ui'
import type { ApplicationMode, ChangeFile } from '../../../types'

export type WorkingTreeDiffFilesErrorCode = 'browser-demo-unavailable' | 'missing-baseline-revision'

/**
 * 展开全文领域错误同时保留本地化文案和稳定错误码。
 *
 * 文案用于界面直接展示；错误码用于测试、日志与后续恢复策略，避免全局 i18n 语言
 * 切换让非 React 异步调用失去稳定语义。
 */
export class WorkingTreeDiffFilesError extends Error {
  constructor(
    public readonly code: WorkingTreeDiffFilesErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'WorkingTreeDiffFilesError'
  }
}

/**
 * 展开全文时读取工作区前后文件的依赖注入，便于纯函数单元测试。
 */
export interface ResolveWorkingTreeDiffFilesOptions {
  /** 浏览器演示模式没有真实数据源，保持部分视图而不是伪造全文。 */
  applicationMode: ApplicationMode
  /**
   * 当前锚点 Revision；空仓库（尚无提交）时为空字符串，表示旧侧没有已提交
   * 基线可读。
   */
  currentRevisionId?: string
  /** 当前主要文件；决定哪一侧不存在（新增无旧侧、删除无新侧）。 */
  file: ChangeFile | null
  /** 读取指定不可变 Revision 中文件的文本内容；仅修改/删除文件需要。 */
  readRevisionText: (revision: string, path: string) => Promise<string>
  /** 读取工作区文件的文本内容。 */
  readWorkspaceText: (path: string) => Promise<string>
}

/**
 * 决定工作区展开全文需要水合的完整前后文件。
 *
 * 新增文件与纯重命名的旧侧没有可读内容，统一按空文件水合；删除文件的新侧
 * 为空；只有修改或删除文件需要读取旧 Revision。仓库尚无提交时所有文件都是
 * 新增，仍应允许展开（旧侧为空），不能把整段水合误判为演示模式不可用。
 * 返回形状与 Diffs 库 `FileDiffLoadedFiles` 一致，由 TextDiffView 完成水合。
 */
export async function resolveWorkingTreeDiffFiles(
  target: TextDiffFullFileTarget,
  options: ResolveWorkingTreeDiffFilesOptions
): Promise<FileDiffLoadedFiles> {
  if (options.applicationMode === 'browser-demo') {
    throw new WorkingTreeDiffFilesError('browser-demo-unavailable', t('browserDemoMode'))
  }
  const oldPath = target.prevName ?? target.name
  const needsOldRevision = target.type !== 'rename-pure' && options.file?.status !== 'added'
  if (needsOldRevision && !options.currentRevisionId) {
    throw new WorkingTreeDiffFilesError('missing-baseline-revision', t('workingDiffMissingBaselineRevision'))
  }
  const oldFile = needsOldRevision
    ? { name: oldPath, contents: await options.readRevisionText(options.currentRevisionId!, oldPath) }
    : options.file?.status === 'added'
      ? { name: oldPath, contents: '' }
      : null
  const newFile =
    options.file?.status === 'deleted'
      ? { name: target.name, contents: '' }
      : { name: target.name, contents: await options.readWorkspaceText(target.name) }
  return oldFile ? { oldFile, newFile } : { oldFile: null, newFile }
}
