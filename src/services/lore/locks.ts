/** 文件锁的查询、获取与释放，以及锁事件解析。 */
import type { LoreEvent, LoreFileLock, LoreOperationResult } from '../../types'
import { runOperation } from './core'
import { readNumber, readString } from './utils'

/** 查询当前 Branch 的协作锁；全 Branch 查询只在用户打开管理页时触发。 */
export async function queryFileLocks(
  repositoryPath: string,
  branch: string,
  owner?: string,
  path?: string
): Promise<LoreFileLock[]> {
  const result = await runOperation('lore_lock_file_query', {
    repositoryPath,
    branch,
    owner: owner?.trim() || null,
    path: path?.trim() || null
  })
  return parseFileLocks(result.events, branch, 'lockFileQuery')
}

/** 按明确路径批量读取协作锁，避免大型仓库在普通文件视图中执行全仓查询。 */
export async function loadFileLockStatus(
  repositoryPath: string,
  branch: string,
  paths: string[]
): Promise<LoreFileLock[]> {
  if (paths.length === 0) return []
  const result = await runOperation('lore_lock_file_status', {
    repositoryPath,
    branch,
    paths
  })
  return parseFileLocks(result.events, branch, 'lockFileStatus')
}

/** 获取协作提示锁；成功事件仍由调用方在操作中心保留。 */
export async function acquireFileLocks(
  repositoryPath: string,
  branch: string,
  paths: string[]
): Promise<LoreOperationResult> {
  return runOperation('lore_lock_file_acquire', { repositoryPath, branch, paths })
}

/** 释放当前已认证身份持有的协作提示锁。 */
export async function releaseFileLocks(
  repositoryPath: string,
  branch: string,
  paths: string[]
): Promise<LoreOperationResult> {
  return runOperation('lore_lock_file_release', { repositoryPath, branch, paths })
}

/** Lock Query 与 Status 仅在事件标签和 Branch 字段来源上不同。 */
export function parseFileLocks(events: LoreEvent[], branch: string, tagName: string): LoreFileLock[] {
  return events
    .filter((event) => event.tagName === tagName)
    .map((event) => ({
      path: readString(event.data.path, ''),
      branch: readString(event.data.branch, branch),
      owner: readString(event.data.owner, ''),
      lockedAt: readNumber(event.data.lockedAt)
    }))
    .filter((lock) => Boolean(lock.path))
}
