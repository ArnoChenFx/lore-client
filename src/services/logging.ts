import { invoke, isTauri } from '@tauri-apps/api/core'
import { debug, error as writeError, info, warn } from '@tauri-apps/plugin-log'

import type { ApplicationLogInfo } from '../types'

const MAX_LOG_MESSAGE_LENGTH = 4_000

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
 * 统一记录 IPC 生命周期。只记录稳定命令名与耗时，绝不序列化 args，避免认证信息、
 * 仓库配置或大块文件内容进入日志。
 */
export async function invokeLogged<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const startedAt = performance.now()
  logDebug('ipc', `started command=${command}`)
  try {
    const result = await invoke<T>(command, args)
    logDebug('ipc', `succeeded command=${command} durationMs=${Math.round(performance.now() - startedAt)}`)
    return result
  } catch (cause) {
    logError(
      'ipc',
      `failed command=${command} durationMs=${Math.round(performance.now() - startedAt)} error=${sanitizeLogMessage(cause)}`
    )
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
