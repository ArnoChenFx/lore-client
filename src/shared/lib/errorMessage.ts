import { t } from '../../i18n'
/**
 * 把跨 JavaScript、Tauri 插件与 Rust IPC 边界抛出的未知值转换为用户可见文案。
 *
 * 当前实现先保持 App 原有行为，便于用独立单元测试锁定“字符串错误被吞掉”的回归；
 * 后续修复必须继续保留 Error 与结构化 `{ message }` 两条既有路径。
 */
export function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  /*
   * Tauri 插件的权限拒绝等错误会直接以字符串 reject Promise。字符串必须优先
   * 原样保留，否则真实的 capability 或系统错误会退化成不可诊断的固定兜底文案。
   */
  if (typeof error === 'string' && error.trim()) {
    return error
  }
  if (typeof error === 'object' && error && 'message' in error) {
    return String(error.message)
  }
  return t('unknownErrorOccurredCheckLore_5959')
}
