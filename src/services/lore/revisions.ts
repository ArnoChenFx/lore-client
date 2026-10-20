/** 修订的查询、修改、历史、变更列表与文件历史。 */
import { parseCommitIdentity } from '../../shared/lib'
import type {
  OperationContext,
  Branch,
  ChangeFile,
  ChangeStatus,
  FileContentClassification,
  FileHistoryEntry,
  LoreEvent,
  LoreOperationResult,
  LoreRevisionBisectResult,
  LoreRevisionInfo,
  LoreRevisionHistoryEntry,
  LoreRevisionHistoryResult,
  Repository,
  Revision,
  RevisionBranchPointer,
  RevisionFile,
  RevisionHistoryQuery,
  WorkingTreeDiff
} from '../../types'
import { createOperationContext, withOperationRequest } from '../operationRequests'
import { LoreOperationError, invokeCommand, runOperation } from './core'
import {
  ZERO_HASH_PATTERN,
  eventData,
  formatBytes,
  readBoolean,
  readFileContentClassification,
  readMetadataValue,
  readNumber,
  readString
} from './utils'
import { parseWorkingTreeDiffs } from './workspace'

/** 读取 Revision 信息、父节点、Delta 与元数据。 */
export async function loadRevisionInfo(
  repositoryPath: string,
  revision: string,
  operationContext?: OperationContext
): Promise<LoreRevisionInfo> {
  const result = await runOperation(
    'lore_revision_info',
    {
      repositoryPath,
      revision,
      includeDelta: true,
      includeMetadata: true
    },
    operationContext
  )
  return parseRevisionInfo(result.events)
}

/** 在当前 Branch 上按 Revision 编号查找精确签名。 */
export async function findRevisionByNumber(
  repositoryPath: string,
  revisionNumber: number,
  operationContext?: OperationContext
): Promise<string> {
  const result = await runOperation(
    'lore_revision_find',
    {
      repositoryPath,
      metadataKey: null,
      metadataValue: null,
      revisionNumber
    },
    operationContext
  )
  return parseRevisionFind(result.events)
}

/** 在当前 Branch 上按元数据键和可选值查找精确签名。 */
export async function findRevisionByMetadata(
  repositoryPath: string,
  metadataKey: string,
  metadataValue?: string,
  operationContext?: OperationContext
): Promise<string> {
  const result = await runOperation(
    'lore_revision_find',
    {
      repositoryPath,
      metadataKey,
      metadataValue: metadataValue?.trim() || null,
      revisionNumber: null
    },
    operationContext
  )
  return parseRevisionFind(result.events)
}

export async function amendCurrentRevision(
  repositoryPath: string,
  branch: string,
  expectedRevision: string,
  message: string,
  operationContext?: OperationContext
): Promise<LoreOperationResult> {
  return runOperation('lore_revision_amend', { repositoryPath, branch, expectedRevision, message }, operationContext)
}

export async function bisectRevisionRange(
  repositoryPath: string,
  start: string,
  end: string,
  expectedRevision: string,
  operationContext?: OperationContext
): Promise<{ operation: LoreOperationResult; result: LoreRevisionBisectResult }> {
  const operation = await runOperation(
    'lore_revision_bisect',
    {
      repositoryPath,
      start,
      end,
      expectedRevision
    },
    operationContext
  )
  return { operation, result: parseRevisionBisect(operation.events) }
}

export async function restoreCurrentRevision(
  repositoryPath: string,
  expectedRevision: string,
  message: string,
  operationContext?: OperationContext
): Promise<LoreOperationResult> {
  return runOperation('lore_revision_restore', { repositoryPath, expectedRevision, message }, operationContext)
}

/**
 * 读取目标 Revision 相对第一父 Revision（或空树）的完整文件差异。
 *
 * 空路径数组表示比较全部路径；根 Revision 使用 `null` 来源，Rust 适配层会
 * 显式读取不可变 Revision Tree，不能回退到当前工作区锚点。
 */
export async function loadRevisionDiff(
  repositoryPath: string,
  sourceRevision: string | null,
  targetRevision: string,
  paths: string[] = [],
  options: {
    contextLines: number
    ignoreWhitespaceEol: boolean
    ignoreWhitespaceInline: boolean
  } = { contextLines: 3, ignoreWhitespaceEol: false, ignoreWhitespaceInline: false },
  operationContext?: OperationContext
): Promise<WorkingTreeDiff[]> {
  const result = await runOperation(
    'lore_revision_diff',
    {
      repositoryPath,
      sourceRevision,
      targetRevision,
      paths,
      contextLines: options.contextLines,
      ignoreWhitespaceEol: options.ignoreWhitespaceEol,
      ignoreWhitespaceInline: options.ignoreWhitespaceInline
    },
    operationContext
  )
  return parseWorkingTreeDiffs(result.events)
}

interface LoreRevisionChangeResult {
  path: string
  sourcePath?: string
  action: string
  size: number
  contentClassification: FileContentClassification
}

/**
 * 读取 Revision 的轻量文件变化清单，不请求任何文件内容或 unified patch。
 *
 * Rust 只比较不可变 Revision Tree 的路径和内容地址；完整 Diff 随后必须通过
 * `loadRevisionDiff(..., [path])` 为当前主要选择按需读取。
 */
export async function loadRevisionChanges(
  repositoryPath: string,
  sourceRevision: string | null,
  targetRevision: string,
  operationContext?: OperationContext
): Promise<ChangeFile[]> {
  const changes = await invokeCommand<LoreRevisionChangeResult[]>(
    'lore_revision_changes',
    {
      repositoryPath,
      sourceRevision,
      targetRevision
    },
    operationContext
  )
  return changes.map((change, index) => {
    const fullPath = change.path.replaceAll('\\', '/')
    const separatorIndex = fullPath.lastIndexOf('/')
    const action = change.action.toLocaleLowerCase()
    const status: ChangeStatus =
      action === 'add' || action === 'copy'
        ? 'added'
        : action === 'delete'
          ? 'deleted'
          : action === 'move'
            ? 'renamed'
            : 'modified'
    const contentClassification = readFileContentClassification(change.contentClassification, 'deferred')
    return {
      id: fullPath || `revision-change-${index}`,
      path: separatorIndex >= 0 ? fullPath.slice(0, separatorIndex) : '.',
      name: separatorIndex >= 0 ? fullPath.slice(separatorIndex + 1) : fullPath,
      status,
      staged: false,
      additions: 0,
      deletions: 0,
      contentClassification,
      size: formatBytes(change.size),
      previousPath: change.sourcePath?.replaceAll('\\', '/') || undefined
    }
  })
}

/** Rust 只读 Revision Tree 命令返回的最小传输结构。 */
interface LoreRevisionFileResult {
  path: string
  size: number
  contentClassification: FileContentClassification
}

/**
 * 读取指定 Revision 的完整已提交文件集合。
 *
 * 与 `loadRevisionDiff` 分离后，“文件树”不会再错误复用本次变更列表，也不会
 * 从当前工作区状态补文件。路径在此转换为稳定前端 DTO，组件不依赖 Lore Node。
 */
export async function loadRevisionFiles(
  repositoryPath: string,
  revision: string,
  operationContext?: OperationContext
): Promise<RevisionFile[]> {
  const files = await invokeCommand<LoreRevisionFileResult[]>(
    'lore_revision_files',
    {
      repositoryPath,
      revision
    },
    operationContext
  )
  return files.map((file, index) => {
    const fullPath = file.path.replaceAll('\\', '/')
    const separatorIndex = fullPath.lastIndexOf('/')
    const contentClassification = readFileContentClassification(file.contentClassification, 'deferred')
    return {
      id: `revision-tree-file:${fullPath || index}`,
      path: separatorIndex >= 0 ? fullPath.slice(0, separatorIndex) : '.',
      name: separatorIndex >= 0 ? fullPath.slice(separatorIndex + 1) : fullPath,
      size: formatBytes(file.size),
      contentClassification
    }
  })
}

/**
 * 把 Lore 的 Revision Diff 事件投影为文件浏览器需要的稳定 DTO。
 *
 * unified diff 的文件头不属于增删内容，统计时必须排除 `---` / `+++`；
 * 二进制只服从 Lore 的内容 marker，不能再根据扩展名隐藏未知文本类型。
 */
export function revisionDiffsToChangeFiles(diffs: readonly WorkingTreeDiff[]): ChangeFile[] {
  return diffs.map((diff, index) => {
    const fullPath = diff.path.replaceAll('\\', '/')
    const separatorIndex = fullPath.lastIndexOf('/')
    const action = diff.action.toLocaleLowerCase()
    const status: ChangeStatus =
      action === 'add' || action === 'copy'
        ? 'added'
        : action === 'delete'
          ? 'deleted'
          : action === 'move' || action === 'rename'
            ? 'renamed'
            : 'modified'
    const contentClassification =
      diff.contentClassification ??
      ({
        kind: diff.patch.includes('Binary files differ') ? 'binary' : 'text',
        source: 'loreDiff'
      } satisfies FileContentClassification)
    const patchLines = diff.patch.split(/\r?\n/)

    return {
      id: `revision-file:${fullPath || index}`,
      path: separatorIndex >= 0 ? fullPath.slice(0, separatorIndex) : '.',
      name: separatorIndex >= 0 ? fullPath.slice(separatorIndex + 1) : fullPath,
      status,
      staged: false,
      additions: patchLines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
      deletions: patchLines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
      /*
       * Lore 已经按真实内容识别二进制。只要没有明确 marker，就不能再因为 `.gd`
       * 或无扩展名等未列入白名单的路径把内容隐藏；空补丁表示零字节结构变化。
       */
      contentClassification
    }
  })
}

/** 读取 Lore 文件历史，并保留可用于关联主历史列表的完整 Revision ID。 */
export async function loadFileHistory(
  repositoryPath: string,
  path: string,
  start?: {
    branch?: string
    revision?: string
  },
  operationContext?: OperationContext
): Promise<FileHistoryEntry[]> {
  /*
   * Lore 明确禁止同时指定 revision 与 branch。历史 Inspector 优先使用精确
   * Revision；只有工作区文件历史没有 Revision 起点时才从当前 Branch latest 查询。
   */
  const revision = start?.revision?.trim() || null
  const result = await runOperation(
    'lore_file_history',
    {
      repositoryPath,
      path,
      branch: revision ? null : start?.branch?.trim() || null,
      revision,
      length: 100
    },
    operationContext
  )
  return parseFileHistory(result.events)
}

/**
 * 把当前实例同步到指定 Branch 的目标 Revision。
 *
 * Lore 会保留 Branch latest 指针；该操作改变的是实例锚点和工作区，并非 Git
 * detached HEAD。Rust 端不会启用 reset/force，因此 Stage 内容仍受保护。
 */
export async function checkoutRevision(
  repositoryPath: string,
  branch: string,
  revision: string,
  operationContext?: OperationContext
): Promise<LoreOperationResult> {
  return runOperation(
    'lore_revision_checkout',
    {
      repositoryPath,
      branch,
      revision
    },
    operationContext
  )
}

/** 历史条目由原生解释一次；非零状态仍保留原有 Lore 错误和认证诊断。 */
export async function loadRevisionHistoryEntries(
  repositoryPath: string,
  query: RevisionHistoryQuery,
  operationContext?: OperationContext
): Promise<LoreRevisionHistoryEntry[]> {
  const result = await invokeCommand<LoreRevisionHistoryResult>(
    'lore_revision_history',
    {
      repositoryPath,
      limit: Math.max(1, Math.min(1_000, query.limit)),
      revision: query.revision?.trim() || null,
      branch: query.branch?.trim() || null,
      date: query.beforeDate || null,
      onlyBranch: query.onlyBranch
    },
    operationContext
  )
  if (result.status !== 0) throw new LoreOperationError(result)
  return result.entries
}

/** 按显式条件重读 Revision History，不触碰工作区状态或当前选区。 */
export async function loadRevisionHistory(
  repository: Repository,
  branches: Branch[],
  query: RevisionHistoryQuery,
  operationContext?: OperationContext
): Promise<Revision[]> {
  return withOperationRequest(operationContext ?? createOperationContext(repository.path), async (requestContext) => {
    const entries = await loadRevisionHistoryEntries(repository.path, query, requestContext)
    return projectRevisionHistory(entries, repository, branches)
  })
}

export function parseRevisionInfo(events: LoreEvent[]): LoreRevisionInfo {
  const data = eventData(events, 'revisionInfo') ?? {}
  const parentIds = (Array.isArray(data.parent) ? data.parent : [])
    .map((parent) => readString(parent))
    .filter((parent) => parent.length > 0 && !ZERO_HASH_PATTERN.test(parent))
  const metadata: Record<string, string | number | boolean> = {}
  for (const event of events.filter((item) => item.tagName === 'metadata')) {
    const key = readString(event.data.key)
    const value = readMetadataValue(event.data.value)
    if (key && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
      metadata[key] = value
    }
  }
  return {
    repository: readString(data.repository),
    revision: readString(data.revision),
    revisionNumber: readNumber(data.revisionNumber),
    parentIds,
    deltas: events
      .filter((event) => event.tagName === 'revisionInfoDelta')
      .map((event) => ({
        path: readString(event.data.path),
        // Lore 0.10.0 新增的来源路径；移动/重命名时才有值。
        fromPath: readString(event.data.fromPath),
        size: readNumber(event.data.size),
        action: readString(event.data.action, 'modify').toLowerCase(),
        modified: readBoolean(event.data.flagModify),
        merged: readBoolean(event.data.flagMerged),
        file: readBoolean(event.data.flagFile)
      }))
      .filter((delta) => delta.path.length > 0),
    metadata
  }
}

export function parseRevisionFind(events: LoreEvent[]): string {
  const signature = readString(eventData(events, 'revisionFind')?.signature)
  return ZERO_HASH_PATTERN.test(signature) ? '' : signature
}

export function parseRevisionBisect(events: LoreEvent[]): LoreRevisionBisectResult {
  const data = eventData(events, 'revisionBisect') ?? {}
  return {
    startRevisionNumber: readNumber(data.startRevisionNumber),
    targetRevisionNumber: readNumber(data.targetRevisionNumber),
    endRevisionNumber: readNumber(data.endRevisionNumber),
    done: readBoolean(data.done)
  }
}

export function parseChanges(events: LoreEvent[]): ChangeFile[] {
  return events
    .filter(
      (event) => event.tagName === 'repositoryStatusFile' && readString(event.data.type).toLowerCase() !== 'directory'
    )
    .map((event, index): ChangeFile => {
      const fullPath = readString(event.data.path, `unknown-${index}`)
      const separatorIndex = fullPath.lastIndexOf('/')
      const action = readString(event.data.action).toLowerCase()
      const status: ChangeStatus =
        action === 'add' || action === 'copy'
          ? 'added'
          : action === 'delete'
            ? 'deleted'
            : action === 'move'
              ? 'renamed'
              : 'modified'
      const contentClassification = readFileContentClassification(event.data.contentClassification, 'unavailable')

      return {
        // 路径在一次仓库快照内唯一，使用它作为稳定 ID，视图切换和刷新后仍能保留选择。
        id: fullPath,
        path: separatorIndex >= 0 ? fullPath.slice(0, separatorIndex) : '.',
        name: separatorIndex >= 0 ? fullPath.slice(separatorIndex + 1) : fullPath,
        status,
        staged: readBoolean(event.data.flagStaged),
        additions: 0,
        deletions: 0,
        contentClassification,
        size: formatBytes(readNumber(event.data.size)),
        previousPath: readString(event.data.fromPath).replaceAll('\\', '/') || undefined,
        conflict: readBoolean(event.data.flagConflict),
        conflictUnresolved: readBoolean(event.data.flagConflictUnresolved)
      }
    })
}

export function parseFileHistory(events: LoreEvent[]): FileHistoryEntry[] {
  return events
    .filter((event) => event.tagName === 'fileHistory')
    .map((event): FileHistoryEntry => ({
      path: readString(event.data.path),
      /*
       * `fileHistory` 是 0.10.0 真正新增 `fromPath` 的事件（上游
       * `LoreFileHistoryEventData`），移动/重命名时给出真实来源路径，
       * 新增/修改/删除为空。空值不得回退成 `path`，否则会把普通修改伪装成移动。
       */
      fromPath: readString(event.data.fromPath),
      revision: readString(event.data.revision),
      revisionNumber: readNumber(event.data.revisionNumber),
      parent: Array.isArray(event.data.parent)
        ? event.data.parent.filter((value): value is string => typeof value === 'string')
        : [],
      size: readNumber(event.data.size),
      action: readString(event.data.action, 'keep').toLowerCase()
    }))
    .filter((entry) => entry.path.length > 0 && entry.revision.length > 0)
}

/** 应用历史事实到当前界面的作者与指针投影，不再读取 Lore 原始事件。 */
export function projectRevisionHistory(
  entries: readonly LoreRevisionHistoryEntry[],
  repository: Repository,
  branches: Branch[] = []
): Revision[] {
  return entries.map((entry): Revision => {
    const id = entry.revision
    // 作者身份只来自该历史条目，不能使用当前仓库的提交身份回填。
    const historicalIdentity = entry.authorIdentity
    const { name, email } = parseCommitIdentity(historicalIdentity)
    const author = name || email
    const parentIds = entry.parentIds
    const parentCount = parentIds.length

    /*
     * Branch 是会移动的指针，不是 Revision 的历史归属。只把 `latest` 与当前
     * Revision 精确相等的活动 Branch 附着到这一行；同名的本地/远端 Branch
     * 依靠稳定 ID 与 kind 区分，不能从名称或图谱 lane 反推。
     */
    const branchPointers: RevisionBranchPointer[] = branches
      .filter((branch) => !branch.archived && branch.latest === id)
      .sort((left, right) => {
        if (Boolean(left.current) !== Boolean(right.current)) {
          return left.current ? -1 : 1
        }
        if (Boolean(left.remote) !== Boolean(right.remote)) {
          return left.remote ? 1 : -1
        }
        return left.name.localeCompare(right.name)
      })
      .map((branch) => ({
        id: branch.id,
        name: branch.name,
        kind: branch.remote ? ('remote' as const) : ('local' as const)
      }))

    /*
     * HEAD 表示当前 Instance 的真实 Revision 锚点，不是历史首行，也不是 Branch
     * latest 的别名。历史可以从 Branch tip 开始，而 HEAD 精确停在更早的任意行。
     */
    if (id === repository.revision) {
      branchPointers.push({
        id: 'head',
        name: 'HEAD',
        kind: 'head'
      })
    }

    return {
      id,
      shortId: id.slice(0, 8),
      title: entry.message,
      revisionNumber: entry.revisionNumber,
      committedAt: entry.committedAt,
      author,
      authorIdentity: historicalIdentity,
      authorEmail: email || undefined,
      initials: author.slice(0, 1).toLocaleUpperCase(),
      branchPointers,
      parentCount,
      parentIds,
      filesChanged: 0,
      additions: 0,
      deletions: 0
    }
  })
}
