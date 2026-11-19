/** 仓库校验、状态转储、实例管理与垃圾回收。 */
import { t } from '../../i18n'
import type {
  InstanceCloneRequest,
  LoreEvent,
  LoreInstanceCloneMethod,
  LoreInstanceClonePlan,
  LoreInstanceClonePreview,
  LoreInstanceCloneResult,
  OperationContext,
  LoreDiagnosticReport,
  LoreOperationResult,
  LoreRepositoryInstance,
  LoreRepositoryInstanceStaleness
} from '../../types'
import { LoreOperationError, invokeCommand, runOperation } from './core'
import { normalizeDisplayPath, readBoolean, readInstanceId, readNumber, readString } from './utils'

export async function verifyRepository(
  repositoryPath: string,
  operationContext?: OperationContext
): Promise<LoreOperationResult> {
  return runOperation('lore_repository_verify', { repositoryPath, path: null, heal: false }, operationContext)
}

/** 对指定路径执行只读验证或用户确认后的受控修复。 */
export async function verifyRepositoryPath(
  repositoryPath: string,
  path: string,
  heal = false,
  operationContext?: OperationContext
): Promise<LoreDiagnosticReport> {
  const result = await runOperation(
    'lore_repository_verify',
    {
      repositoryPath,
      path: path || null,
      heal
    },
    operationContext
  )
  return parseDiagnosticReport(result)
}

/** 验证明确 Fragment；heal 只在高级诊断确认流程中传入。 */
export async function verifyRepositoryFragment(
  repositoryPath: string,
  hash: string,
  context = '',
  heal = false,
  operationContext?: OperationContext
): Promise<LoreDiagnosticReport> {
  return parseDiagnosticReport(
    await runOperation(
      'lore_repository_verify_fragment',
      {
        repositoryPath,
        hash,
        context: context.trim() || null,
        heal
      },
      operationContext
    )
  )
}

/** 读取受深度限制的 Repository State 诊断树。 */
export async function dumpRepositoryState(
  repositoryPath: string,
  revision: string,
  path: string,
  maxDepth: number,
  operationContext?: OperationContext
): Promise<LoreDiagnosticReport> {
  return parseDiagnosticReport(
    await runOperation(
      'lore_repository_dump',
      {
        repositoryPath,
        revision: revision.trim() || null,
        path: path || null,
        maxDepth
      },
      operationContext
    )
  )
}

/** 读取全部本地 Instance，并保留 Core 判定的 stale 标记。 */
export async function listRepositoryInstances(
  repositoryPath: string,
  operationContext?: OperationContext
): Promise<LoreRepositoryInstance[]> {
  const result = await runOperation('lore_repository_instance_list', { repositoryPath }, operationContext)
  return result.events
    .filter((event) => event.tagName === 'repositoryInstance')
    .map((event) => ({
      id: readInstanceId(event.data.instanceId),
      path: normalizeDisplayPath(readString(event.data.path)),
      branchName: readString(event.data.branchName),
      branchId: readString(event.data.branch),
      revision: readString(event.data.revision),
      stale: readInstanceStaleness(event.data.stale)
    }))
}

/**
 * 把 Lore 的 `stale` 字段归一化为稳定三态。
 *
 * Lore 0.10.0 把该字段从布尔值细化为原因码：
 * `1` 路径已不存在、`2` 该路径的 `.lore/instance` 指向另一个 Instance（被重建或
 * 重新 Clone 取代）、`3` 该路径下读不到 `.lore/instance`。无法识别的数值仍算失效，
 * 但归入 `unknown`，不得编造原因。
 */
function readInstanceStaleness(value: unknown): LoreRepositoryInstanceStaleness {
  if (typeof value !== 'number') return readBoolean(value) ? 'unknown' : null
  if (value === 0) return null
  if (value === 2) return 'superseded'
  if (value === 3) return 'no-checkout'
  if (value === 1) return 'path-missing'
  return 'unknown'
}

export async function pruneRepositoryInstances(
  repositoryPath: string,
  operationContext?: OperationContext
): Promise<LoreOperationResult> {
  return runOperation('lore_repository_instance_prune', { repositoryPath }, operationContext)
}

export async function updateRepositoryInstancePath(
  repositoryPath: string,
  operationContext?: OperationContext
): Promise<LoreOperationResult> {
  return runOperation('lore_repository_instance_update_path', { repositoryPath }, operationContext)
}

/** Rust 命令的返回形状：Lore 的非零状态保留在 `result.status`，由调用方决定如何呈现。 */
interface InstanceCloneCall {
  targetPath: string
  result: LoreOperationResult
}

async function invokeInstanceClone(
  repositoryPath: string,
  request: InstanceCloneRequest,
  dryRun: boolean,
  operationContext?: OperationContext
): Promise<InstanceCloneCall> {
  const call = await invokeCommand<InstanceCloneCall>(
    'lore_repository_instance_clone',
    {
      repositoryPath,
      destinationParent: request.parentDirectory.trim(),
      directoryName: request.directoryName.trim(),
      allowCopy: request.allowCopy,
      dryRun
    },
    operationContext
  )
  return { ...call, targetPath: normalizeDisplayPath(call.targetPath) }
}

/**
 * 实例克隆预检（Lore dry run）：不加锁、不写入任何内容，只回答“将如何克隆”。
 *
 * 预检阶段被拒绝（例如无法共享数据块而用户没有允许复制）时，Lore 仍然先发出 Begin 事件，
 * 这里把它作为 `refusal` 返回，让界面用计划解释原因；没有计划的拒绝原样抛出。
 */
export async function previewRepositoryInstanceClone(
  repositoryPath: string,
  request: InstanceCloneRequest,
  operationContext?: OperationContext
): Promise<LoreInstanceClonePreview> {
  const call = await invokeInstanceClone(repositoryPath, request, true, operationContext)
  const plan = parseInstanceClonePlan(call.result.events)
  if (call.result.status === 0) {
    if (!plan) throw new Error(t('instanceCloneEventsMissing'))
    return { targetPath: call.targetPath, plan, refusal: null }
  }
  const failure = new LoreOperationError(call.result)
  if (!plan) throw failure
  return { targetPath: call.targetPath, plan, refusal: { status: failure.status, message: failure.message } }
}

/**
 * 真正克隆当前 Instance。它会持有源 Instance 与 Store 的锁到完成，调用方必须经过 Repository 写队列
 * 并先让用户确认；任何失败都以 `LoreOperationError` 抛出，Lore 自己清理已复制的内容。
 */
export async function cloneRepositoryInstance(
  repositoryPath: string,
  request: InstanceCloneRequest,
  operationContext?: OperationContext
): Promise<LoreInstanceCloneResult> {
  const call = await invokeInstanceClone(repositoryPath, request, false, operationContext)
  if (call.result.status !== 0) throw new LoreOperationError(call.result)
  const result = parseInstanceCloneResult(call.result.events, call.targetPath)
  if (!result) throw new Error(t('instanceCloneEventsMissing'))
  return result
}

/**
 * 从 `repositoryInstanceCloneBegin` 事件读取克隆计划。
 *
 * 方式字段只认两个已知取值，其余一律降级为 `unsupported`：将来上游新增方式时，客户端宁可
 * 拒绝，也不能把它当成“几乎不占空间”的共享数据块。
 */
export function parseInstanceClonePlan(events: LoreEvent[]): LoreInstanceClonePlan | null {
  const event = events.find((candidate) => candidate.tagName === 'repositoryInstanceCloneBegin')
  if (!event) return null
  const data = event.data
  return {
    method: readInstanceCloneMethod(data.method),
    sourcePath: normalizeDisplayPath(readString(data.sourcePath)),
    targetPath: normalizeDisplayPath(readString(data.targetPath)),
    filesystem: readString(data.filesystem),
    mountPoint: normalizeDisplayPath(readString(data.mountPoint)),
    size: readNumber(data.size),
    fileCount: readNumber(data.fileCount),
    availableSize: readNumber(data.availableSize),
    reason: readString(data.reason)
  }
}

function readInstanceCloneMethod(value: unknown): LoreInstanceCloneMethod {
  if (value === 'sharesBlocks') return 'sharesBlocks'
  if (value === 'copiesBytes') return 'copiesBytes'
  return 'unsupported'
}

/** 从 `repositoryInstanceCloneComplete` 事件读取结果；事件缺失返回 null，不编造成功。 */
export function parseInstanceCloneResult(
  events: LoreEvent[],
  fallbackTargetPath: string
): LoreInstanceCloneResult | null {
  const event = events.find((candidate) => candidate.tagName === 'repositoryInstanceCloneComplete')
  if (!event) return null
  const data = event.data
  return {
    targetPath: normalizeDisplayPath(readString(data.targetPath, fallbackTargetPath)),
    instanceId: readInstanceId(data.instanceId),
    clonedDirectoryCount: readNumber(data.clonedDirectoryCount),
    clonedEntryCount: readNumber(data.clonedEntryCount),
    copiedFileCount: readNumber(data.copiedFileCount)
  }
}

/** 把 Lore 诊断事件收敛成只含类型、摘要与详情的稳定展示结构。 */
export function parseDiagnosticReport(result: LoreOperationResult): LoreDiagnosticReport {
  const findings = result.events
    .filter((event) => !['end', 'complete'].includes(event.tagName))
    .map((event) => {
      const data = event.data
      const error = event.tagName === 'error' || Boolean(readString(data.error))
      const summary =
        readString(data.message) ||
        readString(data.path) ||
        readString(data.hash) ||
        readString(data.revision) ||
        event.tagName
      return {
        kind: event.tagName,
        summary,
        detail: Object.keys(data).length > 0 ? JSON.stringify(data, null, 2) : '',
        error
      }
    })
  return { operation: result.operation, durationMs: result.durationMs, findings }
}

export async function collectRepositoryGarbage(
  repositoryPath: string,
  operationContext?: OperationContext
): Promise<LoreOperationResult> {
  return runOperation('lore_repository_gc', { repositoryPath }, operationContext)
}
