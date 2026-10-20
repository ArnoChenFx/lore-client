/** 工作区的暂存、差异、丢弃、提交、同步与打开操作。 */
import { readMoveSourceFromPatch } from '../../shared/lib'
import type {
  OperationContext,
  LoreDependencySelection,
  LoreEvent,
  LoreOperationResult,
  WorkingTreeDiff
} from '../../types'
import { invokeLogged } from '../logging'
import { invokeCommand, runOperation } from './core'
import { readString } from './utils'

export async function stagePaths(
  repositoryPath: string,
  paths: string[],
  operationContext?: OperationContext
): Promise<LoreOperationResult> {
  return runOperation('lore_stage', { repositoryPath, paths }, operationContext)
}

/** 使用 Lore 原生移动语义原子暂存来源删除与目标新增。 */
export async function stageMove(
  repositoryPath: string,
  sourcePath: string,
  targetPath: string,
  operationContext?: OperationContext
): Promise<LoreOperationResult> {
  return runOperation('lore_stage_move', { repositoryPath, sourcePath, targetPath }, operationContext)
}

export async function unstagePaths(
  repositoryPath: string,
  paths: string[],
  operationContext?: OperationContext
): Promise<LoreOperationResult> {
  return runOperation('lore_unstage', { repositoryPath, paths }, operationContext)
}

/** 读取当前锚点 Revision 与工作区文件系统之间的真实 unified diff。 */
export async function loadWorkingTreeDiff(
  repositoryPath: string,
  paths: string[],
  options: {
    contextLines: number
    ignoreWhitespaceEol: boolean
    ignoreWhitespaceInline: boolean
  } = { contextLines: 3, ignoreWhitespaceEol: false, ignoreWhitespaceInline: false },
  operationContext?: OperationContext
): Promise<WorkingTreeDiff[]> {
  const result = await runOperation(
    'lore_workspace_diff',
    {
      repositoryPath,
      paths,
      contextLines: options.contextLines,
      ignoreWhitespaceEol: options.ignoreWhitespaceEol,
      ignoreWhitespaceInline: options.ignoreWhitespaceInline
    },
    operationContext
  )
  return parseWorkingTreeDiffs(result.events)
}

/** 丢弃明确选择的工作区文件变化；新增文件也由 Lore 在限定路径内清理。 */
export async function discardWorkspaceFiles(
  repositoryPath: string,
  paths: string[],
  revision: string,
  operationContext?: OperationContext
): Promise<LoreOperationResult> {
  return runOperation(
    'lore_discard_workspace_files',
    {
      repositoryPath,
      paths,
      revision
    },
    operationContext
  )
}

/** 将指定仓库相对路径恢复到目标 Revision，并保留 Lore 的完整事件结果。 */
export async function resetFilesToRevision(
  repositoryPath: string,
  paths: string[],
  revision: string,
  operationContext?: OperationContext
): Promise<LoreOperationResult> {
  return runOperation(
    'lore_file_reset',
    {
      repositoryPath,
      paths,
      revision
    },
    operationContext
  )
}

export async function commitRevision(
  repositoryPath: string,
  message: string,
  defaultIdentity?: string,
  operationContext?: OperationContext
): Promise<LoreOperationResult> {
  return runOperation(
    'lore_commit',
    {
      repositoryPath,
      message,
      defaultIdentity: defaultIdentity?.trim() || null
    },
    operationContext
  )
}

export async function syncRepository(
  repositoryPath: string,
  dependency: LoreDependencySelection = { rootFiles: [], tags: [], recursive: false, depthLimit: 0 },
  operationContext?: OperationContext
): Promise<LoreOperationResult> {
  return runOperation(
    'lore_sync',
    {
      repositoryPath,
      dependencyRootFiles: dependency.rootFiles,
      dependencyTags: dependency.tags,
      dependencyRecursive: dependency.recursive,
      dependencyDepthLimit: dependency.depthLimit
    },
    operationContext
  )
}

export async function pushBranch(
  repositoryPath: string,
  branch?: string,
  operationContext?: OperationContext
): Promise<LoreOperationResult> {
  return runOperation(
    'lore_push',
    {
      repositoryPath,
      branch: branch || null
    },
    operationContext
  )
}

/** 使用系统文件管理器定位当前 Lore 工作区。 */
export async function openWorkspace(repositoryPath: string, operationContext?: OperationContext): Promise<void> {
  await invokeLogged('lore_open_workspace', { repositoryPath }, operationContext)
}

/** 使用系统文件管理器选中仓库内文件；删除文件会由原生层退回到所在目录。 */
export async function revealWorkspaceFile(
  repositoryPath: string,
  relativePath: string,
  operationContext?: OperationContext
): Promise<void> {
  await invokeLogged(
    'lore_reveal_workspace_file',
    {
      repositoryPath,
      relativePath
    },
    operationContext
  )
}

/** 使用系统关联应用打开仓库内的现有文件。 */
export async function openWorkspaceFile(
  repositoryPath: string,
  relativePath: string,
  operationContext?: OperationContext
): Promise<void> {
  await invokeCommand<void>(
    'lore_open_workspace_file',
    {
      repositoryPath,
      relativePath
    },
    operationContext
  )
}

/** 将选中路径或其扩展名安全追加到 `.loreignore`。 */
export async function ignoreWorkspacePaths(
  repositoryPath: string,
  paths: string[],
  byExtension: boolean,
  operationContext?: OperationContext
): Promise<string[]> {
  return invokeCommand<string[]>(
    'lore_ignore_paths',
    {
      repositoryPath,
      paths,
      byExtension
    },
    operationContext
  )
}

export function parseWorkingTreeDiffs(events: LoreEvent[]): WorkingTreeDiff[] {
  return events
    .filter((event) => event.tagName === 'fileDiff')
    .map((event): WorkingTreeDiff => {
      const patch = readString(event.data.patch)
      return {
        path: readString(event.data.path),
        patch,
        action: readString(event.data.action, 'keep').toLowerCase(),
        /*
         * 移动来源只在补丁头的 `move from <路径>` 行里，事件本身没有该字段；
         * 非移动/重命名动作没有这一行，因此 `undefined` 就是准确的“没有来源”。
         */
        previousPath: readMoveSourceFromPatch(patch),
        contentClassification: {
          kind: patch.includes('Binary files differ') ? 'binary' : 'text',
          source: 'loreDiff'
        }
      }
    })
    .filter((diff) => diff.path.length > 0)
}
