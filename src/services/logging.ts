import { invoke, isTauri } from '@tauri-apps/api/core'
import { debug, error as writeError, info, warn } from '@tauri-apps/plugin-log'

import type { ApplicationLogInfo } from '../types'

const MAX_LOG_MESSAGE_LENGTH = 4_000
const EXPECTED_IPC_CONTROL_FLOW_CODES = new Set([
  'auth_binding_missing',
  'auth_binding_identity_not_requested',
  // 高频切换时 Rust 会在进入真实 I/O 前淘汰旧重读；这是正常调度结果，不是用户故障。
  'heavy_read_superseded'
])

/**
 * 在日志写入磁盘前移除常见凭据形式。
 *
 * 本函数是最后一道保护；调用方仍不得把 IPC 参数、Token DTO 或用户输入整体传入日志。
 * 保留错误中的本地路径和状态码，因为它们对定位仓库损坏与权限问题很重要；文档会明确
 * 提醒用户在对外分享日志前检查这些本机信息。
 */
export function sanitizeLogMessage(value: unknown): string {
  let message = readLogValue(value)
  message = message
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/([?&](?:access_token|auth_token|id_token|token|password)=)[^&#\s]*/gi, '$1[REDACTED]')
    .replace(
      /((?:"|')?(?:accessToken|authToken|idToken|token|password)(?:"|')?\s*[:=]\s*)(["'])[^"']*\2/gi,
      '$1$2[REDACTED]$2'
    )
    .replace(/:\/\/([^\s/@:]+):([^\s/@]+)@/g, '://[REDACTED]@')

  if (message.length > MAX_LOG_MESSAGE_LENGTH) {
    return `${message.slice(0, MAX_LOG_MESSAGE_LENGTH)}…[TRUNCATED]`
  }
  return message
}

function readLogValue(value: unknown): string {
  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`
  }
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return String(value)
  try {
    return JSON.stringify(value) ?? Object.prototype.toString.call(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}

/**
 * 某些结构化错误表示可选增强能力在当前上下文中不适用，调用方会按设计回退。
 * 这些结果仍保留 Debug 轨迹，但不能冒充需要用户处理的 ERROR。
 */
export function isExpectedIpcControlFlowError(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('code' in value)) return false
  const code = (value as { code?: unknown }).code
  return typeof code === 'string' && EXPECTED_IPC_CONTROL_FLOW_CODES.has(code)
}

type LogWriter = (message: string) => Promise<void>

/** 日志插件不可用时不能反过来打断产品流程；浏览器演示仅写开发控制台。 */
function dispatchLog(writer: LogWriter, fallback: (message: string) => void, scope: string, value: unknown): void {
  const message = `[${scope}] ${sanitizeLogMessage(value)}`
  // Vitest 会 mock Tauri invoke 并断言业务命令次数；测试进程不应写真实桌面日志或污染调用计数。
  if (
    import.meta.env.MODE === 'test' ||
    (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') ||
    'Bun' in globalThis
  ) {
    return
  }
  if (!isTauri()) {
    fallback(message)
    return
  }
  void writer(message).catch(() => fallback(message))
}

export function logDebug(scope: string, value: unknown): void {
  dispatchLog(debug, console.debug, scope, value)
}

export function logInfo(scope: string, value: unknown): void {
  dispatchLog(info, console.info, scope, value)
}

export function logWarning(scope: string, value: unknown): void {
  dispatchLog(warn, console.warn, scope, value)
}

export function logError(scope: string, value: unknown): void {
  dispatchLog(writeError, console.error, scope, value)
}

/**
 * 统一执行 IPC，并只在失败或预期控制流回退时记录稳定命令名与耗时。
 *
 * 成功路径不能再额外调用日志插件：日志插件本身也是一个异步 Tauri IPC。若开发期页面
 * 恰好在仓库恢复期间重载，这个“记录成功”的二次 IPC 会晚于旧页面返回，既制造陈旧
 * callback 告警，也放大 WebView2 页面切换期间的投递压力。失败路径仍保留日志，且绝不
 * 序列化 args，避免认证信息、仓库配置或大块文件内容进入日志。
 */
export async function invokeLogged<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const startedAt = performance.now()
  try {
    return await invoke<T>(command, args)
  } catch (cause) {
    const durationMs = Math.round(performance.now() - startedAt)
    if (isExpectedIpcControlFlowError(cause)) {
      logDebug('ipc', `not-applicable command=${command} durationMs=${durationMs} detail=${sanitizeLogMessage(cause)}`)
    } else {
      logError('ipc', `failed command=${command} durationMs=${durationMs} error=${sanitizeLogMessage(cause)}`)
    }
    throw cause
  }
}

export async function loadApplicationLogInfo(): Promise<ApplicationLogInfo | null> {
  if (!isTauri()) return null
  return invokeLogged<ApplicationLogInfo>('application_log_info')
}

export async function openApplicationLogDirectory(): Promise<void> {
  if (!isTauri()) return
  await invokeLogged('application_log_open_directory')
}

/** 尽早注册全局异常捕获；返回清理函数供嵌入式宿主或测试主动卸载。 */
export function initializeApplicationLogging(): () => void {
  if (typeof window === 'undefined') return () => undefined

  const handleError = (event: ErrorEvent) => logError('window', event.error ?? event.message)
  const handleUnhandledRejection = (event: PromiseRejectionEvent) => logError('promise', event.reason)
  window.addEventListener('error', handleError)
  window.addEventListener('unhandledrejection', handleUnhandledRejection)
  logInfo('startup', 'WebView initialized')

  return () => {
    window.removeEventListener('error', handleError)
    window.removeEventListener('unhandledrejection', handleUnhandledRejection)
  }
}
