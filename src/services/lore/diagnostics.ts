/** 仓库校验、状态转储、实例管理与垃圾回收。 */
import type {
  OperationContext,
  LoreDiagnosticReport,
  LoreOperationResult,
  LoreRepositoryInstance,
  LoreRepositoryInstanceStaleness
} from '../../types'
import { runOperation } from './core'
import { normalizeDisplayPath, readBoolean, readString } from './utils'

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
      id: readString(event.data.instanceId),
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
