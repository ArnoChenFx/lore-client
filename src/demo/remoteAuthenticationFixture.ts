import type { ApplicationMode } from '../types'

export const REMOTE_AUTHENTICATION_FIXTURE_PARAMETER = 'remote-authentication-fixture'

/**
 * 只在浏览器演示且显式携带测试参数时展示认证失效现场。
 *
 * 桌面应用永远依据真实 Lore Status；普通浏览器演示也不应被测试弹层遮挡。查询参数
 * 仅供 UI/视觉验收稳定打开这个无法在纯前端自然触发的全局状态。
 */
export function shouldUseBrowserRemoteAuthenticationFixture(
  applicationMode: ApplicationMode,
  search = typeof window === 'undefined' ? '' : window.location.search
): boolean {
  if (applicationMode !== 'browser-demo') return false
  return new URLSearchParams(search).get(REMOTE_AUTHENTICATION_FIXTURE_PARAMETER) === '1'
}
