/** 冲突会话与冲突操作的读取与解决结果写回。 */
import type { ConflictAction, ConflictOperationKind, ConflictSession, LoreOperationResult } from '../../types'
import { invokeCommand, runOperation } from './core'

/** 读取真实 staged Revision 对应的冲突会话；没有进行中操作时返回 null。 */
export async function loadConflictSession(repositoryPath: string): Promise<ConflictSession | null> {
  return invokeCommand<ConflictSession | null>('lore_conflict_session', { repositoryPath })
}

/**
 * 执行一个真实冲突动作。
 *
 * 文件级动作由 Rust 再次验证非空仓库相对路径；Abort 为仓库级动作并忽略 paths。
 * Lore Core 还会校验 staged State 类型，旧 UI 快照无法把动作误发到另一类冲突。
 */
export async function runConflictAction(
  repositoryPath: string,
  operation: Exclude<ConflictOperationKind, 'unknown'>,
  action: ConflictAction,
  paths: string[] = []
): Promise<LoreOperationResult> {
  return runOperation('lore_conflict_action', {
    repositoryPath,
    operation,
    action,
    paths
  })
}

/** 行内冲突解决写回结果：内容是否已完全解决，以及本次 Lore 操作的事件流。 */
export interface ConflictResolutionWriteResult {
  resolved: boolean
  operation: LoreOperationResult
}

/**
 * 把行内解决后的完整文本写回工作区，并在内容干净时标记为已解决。
 *
 * 只接受单条仓库相对路径；Rust 会重新确认该文件仍处于真实冲突会话，并拒绝
 * 仍包含冲突标记的内容标记完成，避免把未完成的中间状态伪装成 resolved。
 */
export async function writeConflictResolution(
  repositoryPath: string,
  expectedSession: ConflictSession,
  path: string,
  expectedContent: string,
  content: string
): Promise<ConflictResolutionWriteResult> {
  return invokeCommand<ConflictResolutionWriteResult>('lore_write_conflict_resolution', {
    repositoryPath,
    expectedSession,
    path,
    expectedContent,
    content
  })
}
