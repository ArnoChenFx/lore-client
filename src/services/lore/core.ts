/** Lore 服务的基础设施：命令调用、操作流、错误类型、服务器地址与运行时信息。 */
import { isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { UnlistenFn } from '@tauri-apps/api/event'

import { t } from '../../i18n'
import type {
  LoreCommandError,
  LoreEvent,
  LoreOperationResult,
  LoreOperationStreamEvent,
  LoreRepositoryNotification,
  LoreRuntimeInfo
} from '../../types'
import { invokeLogged } from '../logging'
import { isRecord } from './utils'

/** 产品内置的本机 Lore 服务地址；测试它时不能依赖开发者机器上的 `.env`。 */
const BUILT_IN_SERVER_URL = 'lore://127.0.0.1:41337'

/**
 * 解析产品默认服务器地址。
 *
 * 将解析过程保持为纯函数，使“未提供覆盖值”的测试不会被项目根目录 `.env`
 * 污染；空白覆盖值同样视为未配置，避免生成无法连接的空地址。
 */
export function resolveDefaultServerUrl(environmentOverride?: string): string {
  return environmentOverride?.trim() || BUILT_IN_SERVER_URL
}

/** 订阅 Rust 适配层的实时 Lore 操作事件；浏览器演示模式返回空清理函数。 */
export async function subscribeLoreOperationStream(
  listener: (event: LoreOperationStreamEvent) => void
): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined
  return listen<LoreOperationStreamEvent>('lore://operation-stream', (event) => listener(event.payload))
}

/**
 * 连接当前仓库的真实远端通知。
 *
 * 先注册 WebView 监听再调用 Subscribe，避免遗漏上游立即发出的 subscribed 事件；
 * 清理时先请求 Lore Unsubscribe，再移除本地监听。
 */
export async function connectRepositoryNotifications(
  repositoryPath: string,
  listener: (event: LoreRepositoryNotification) => void
): Promise<() => Promise<void>> {
  if (!isTauri()) return async () => undefined
  const unlisten = await listen<LoreRepositoryNotification>('lore://repository-notification', (event) => {
    if (event.payload.repositoryPath === repositoryPath) listener(event.payload)
  })
  try {
    const status = await invokeLogged<number>('lore_notification_subscribe', { repositoryPath })
    if (status !== 0) {
      throw new Error(t('notificationSubscriptionFailed'))
    }
  } catch (error) {
    unlisten()
    throw error
  }
  return async () => {
    try {
      await invokeLogged<number>('lore_notification_unsubscribe', { repositoryPath })
    } finally {
      unlisten()
    }
  }
}

/** 未配置覆盖值时连接本机 Lore 服务；共享测试服务器必须由环境变量显式提供。 */
export const DEFAULT_SERVER_URL = resolveDefaultServerUrl(import.meta.env.VITE_LORE_SERVER_URL)

/**
 * 操作失败时携带 Lore 的原始状态码和事件，便于 UI 展示短提示，
 * 同时保留足够诊断信息供日志页或问题报告使用。
 */
export class LoreOperationError extends Error {
  readonly status: number
  readonly operation: string
  readonly events: LoreEvent[]

  constructor(result: LoreOperationResult) {
    super(readLoreErrorMessage(result))
    this.name = 'LoreOperationError'
    this.status = result.status
    this.operation = result.operation
    this.events = result.events
  }
}

/**
 * 保留 Rust 结构化错误码的前端错误。
 *
 * 认证恢复等控制流必须依据稳定 `code`，不能重新解析已经本地化的人类可读消息。
 */
export class LoreCommandClientError extends Error {
  readonly code: string
  readonly command: string

  constructor(error: Partial<LoreCommandError>, command: string) {
    super(localizeCommandError(error, command))
    this.name = 'LoreCommandClientError'
    this.code = error.code ?? 'lore_command_failed'
    this.command = command
  }
}

/** 仅稳定错误码或 Lore 标准认证错误事件可以触发全局重新认证流程。 */
export function isAuthenticationRequiredError(error: unknown): boolean {
  if (error instanceof LoreCommandClientError) return error.code === 'auth_required'
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String(error.code) === 'auth_required'
  }
  if (!(error instanceof LoreOperationError)) return false
  return error.events.some((event) => {
    const candidate = event.data.error
    if (typeof candidate !== 'object' || candidate === null || !('message' in candidate)) return false
    return String(candidate.message).includes('The request does not have valid authentication credentials')
  })
}

export function getApplicationMode(): 'tauri' | 'browser-demo' {
  return isTauri() ? 'tauri' : 'browser-demo'
}

export async function getLoreRuntimeInfo(): Promise<LoreRuntimeInfo> {
  if (!isTauri()) {
    return {
      application: 'Lore Client',
      available: false,
      integrationMode: 'browser-demo',
      loreCoreStatus: 'preview-only',
      libraryVersion: '0.8.6',
      sourceRevision: 'demo'
    }
  }

  return invokeLogged<LoreRuntimeInfo>('lore_runtime_info')
}

export async function runOperation(command: string, args: Record<string, unknown>): Promise<LoreOperationResult> {
  try {
    const result = await invokeLogged<LoreOperationResult>(command, args)
    if (result.status !== 0) {
      throw new LoreOperationError(result)
    }
    return result
  } catch (error) {
    if (error instanceof LoreOperationError || error instanceof Error) {
      throw error
    }

    // Tauri 会把可序列化的 Rust 错误对象直接交给前端，需要在这里恢复成 Error。
    const commandError = error as Partial<LoreCommandError>
    throw new LoreCommandClientError(commandError, command)
  }
}

/** 把直接返回 DTO 的 Tauri 命令错误统一恢复为标准 Error。 */
export async function invokeCommand<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invokeLogged<T>(command, args)
  } catch (error) {
    if (error instanceof Error) {
      throw error
    }
    const commandError = error as Partial<LoreCommandError>
    throw new LoreCommandClientError(commandError, command)
  }
}

/**
 * Rust 错误消息保留诊断细节，但稳定错误码必须先映射成当前界面语言。
 * 这里仅覆盖客户端能够给出明确恢复建议的错误；其余错误继续保留上游详情。
 */
function localizeCommandError(error: Partial<LoreCommandError>, command: string): string {
  if (error.code === 'auth_required') {
    return t('remoteAuthenticationRequired')
  }
  if (error.code === 'binary_preview_invalid_asset') {
    return t('binaryPreviewInvalidAsset')
  }
  if (error.code === 'binary_preview_asset_variant_unsupported') {
    return t('binaryPreviewUnsupportedAssetVariant')
  }
  if (error.code === 'binary_preview_decode_failed' || error.code === 'binary_preview_encode_failed') {
    return t('binaryPreviewDecodeFailed')
  }
  if (error.code === 'binary_preview_too_large') {
    return t('binaryPreviewTooLarge')
  }
  if (error.code === 'binary_preview_limit_invalid') {
    return t('binaryPreviewLimitInvalid')
  }
  if (error.code === 'binary_preview_unsupported') {
    return t('binaryPreviewUnsupportedFormat')
  }
  if (error.code === 'invalid_clone_target') {
    return t('invalidCloneTarget')
  }
  if (error.code === 'invalid_clone_layer_metadata') {
    return t('invalidCloneLayerMetadata')
  }
  if (error.code === 'invalid_clone_layer_repository') {
    return t('invalidCloneLayerRepository')
  }
  if (error.code === 'clone_layer_repository_required') {
    return t('cloneLayerRepositoryRequired')
  }
  if (error.code === 'clone_bare_materialization_options') {
    return t('cloneBareMaterializationOptions')
  }
  if (error.code === 'composition_field_required') {
    return t('compositionFieldRequired')
  }
  if (error.code === 'composition_field_invalid') {
    return t('compositionFieldInvalid')
  }
  if (error.code === 'invalid_repository_relative_path') {
    return t('invalidRepositoryRelativePath')
  }
  if (error.code === 'fragment_identifier_invalid') {
    return t('fragmentIdentifierInvalid')
  }
  if (error.code === 'metadata_scope_invalid') {
    return t('metadataScopeInvalid')
  }
  if (error.code === 'metadata_revision_required') {
    return t('metadataRevisionRequired')
  }
  if (error.code === 'unknown_conflict_operation') {
    return t('conflictOperationUnknownError')
  }
  if (error.code === 'conflict_state_unavailable') {
    return t('conflictStateUnavailable')
  }
  if (error.code === 'conflict_paths_required') {
    return t('selectConflictFilesToContinue')
  }
  if (error.code === 'workspace_text_unavailable') {
    return t('workspaceTextUnavailable')
  }
  if (error.code === 'workspace_text_classification_failed') {
    return t('workspaceTextClassificationFailed')
  }
  if (error.code === 'workspace_text_metadata_failed') {
    return t('workspaceTextMetadataFailed')
  }
  if (error.code === 'workspace_text_too_large') {
    return t('workspaceTextTooLarge')
  }
  if (error.code === 'workspace_text_decode_failed') {
    return t('workspaceTextDecodeFailed')
  }
  if (error.code === 'conflict_path_not_in_conflict') {
    return t('conflictPathNotInConflict')
  }
  if (error.code === 'conflict_content_changed') {
    return t('conflictContentChanged')
  }
  if (error.code === 'conflict_session_changed') {
    return t('conflictSessionChanged')
  }
  if (error.code === 'workspace_text_write_failed') {
    return t('workspaceTextWriteFailed')
  }
  if (error.code === 'revision_text_file_missing') {
    return t('revisionTextFileMissing')
  }
  if (error.code === 'revision_text_too_large') {
    return t('revisionTextTooLarge')
  }
  if (error.code === 'revision_text_decode_failed') {
    return t('revisionTextDecodeFailed')
  }
  if (error.code === 'repository_view_workspace_dirty') {
    return t('cleanWorkspaceBeforeApplyingView')
  }
  if (error.code === 'repository_view_revision_changed') {
    return t('repositoryViewRevisionChanged')
  }
  if (error.code === 'repository_view_invalid') {
    return t('repositoryViewContainsErrors')
  }
  if (error.code === 'repository_view_too_large') {
    return t('repositoryViewTooLarge')
  }
  if (error.code === 'repository_view_invalid_utf8') {
    return t('repositoryViewMustBeUtf8')
  }
  if (error.code === 'repository_view_status_unavailable') {
    return t('repositoryViewStatusUnavailable')
  }
  if (error.code === 'repository_view_sync_failed') {
    return t('repositoryViewSyncFailedAndRolledBack')
  }
  if (error.code === 'repository_view_dematerialize_failed') {
    return t('repositoryViewDematerializeFailedAndRolledBack')
  }
  if (
    [
      'repository_view_read_failed',
      'repository_view_parent_missing',
      'repository_view_temporary_create_failed',
      'repository_view_temporary_write_failed',
      'repository_view_backup_failed',
      'repository_view_replace_failed',
      'repository_view_cache_release_failed'
    ].includes(error.code ?? '')
  ) {
    return t('repositoryViewStorageFailed')
  }
  return error.message ?? t('status.commandFailed', { command })
}

/**
 * 结构化 FFI 错误码 → 本地化语义键。
 *
 * Lore 0.10.0 起 Complete 事件携带具体错误码（错误码已按失败类别整体重排，旧版
 * 的“遇到顺序”编号不再适用）；这里只覆盖用户可以自助恢复的错误，其余码继续保留
 * 上游详情。新增码时同步 zh-CN 与 en-US。
 */
function localizedLoreErrorCodeKey(code: number): 'loreErrorLocalModifications' | null {
  // LocalModifications：Layer/Link 移除、同步等在存在暂存工作或本地修改时拒绝。
  if (code === 44) return 'loreErrorLocalModifications'
  return null
}

function readLoreErrorMessage(result: LoreOperationResult): string {
  const errorEvent = result.events.find((event) => event.tagName === 'error')
  if (typeof errorEvent?.data.errorInner === 'string') {
    return errorEvent.data.errorInner
  }

  const complete = result.events.find((event) => event.tagName === 'complete')
  const detail = complete?.data.error
  const detailMessage = isRecord(detail)
    ? ['message', 'inner', 'context']
        .map((key) => (typeof detail[key] === 'string' && detail[key] ? String(detail[key]) : ''))
        .find(Boolean)
    : undefined

  /*
   * 已知 FFI 码优先渲染为本地化主文案，后面保留上游详情：拒绝类错误（如 Layer
   * 移除拒绝时的 staged 文件数）仍有诊断价值，但裸英文 Display 不适合作为
   * 长期界面文案。未知码保持既有行为，不猜测语义。
   */
  const localizedKey = localizedLoreErrorCodeKey(result.status)
  if (localizedKey) {
    return detailMessage ? `${t(localizedKey)}\n${detailMessage}` : t(localizedKey)
  }

  if (detailMessage) {
    return detailMessage
  }
  return t('status.operationFailedWithStatus', {
    operation: result.operation,
    status: result.status
  })
}

/** 从仓库完整远端 URL 提取服务器根地址，供项目切换时刷新服务器面板。 */
export function serverUrlFromRepositoryUrl(remoteUrl: string): string {
  const match = remoteUrl.trim().match(/^([a-z][a-z0-9+.-]*:\/\/[^/]+)/i)
  return match?.[1] ?? remoteUrl.trim()
}
