import type { ApplicationMode } from '../types'

export const UPDATE_DIALOG_FIXTURE_PARAMETER = 'update-dialog-fixture'

/**
 * 浏览器演示中的确定性更新现场。
 *
 * 该状态只用于查看弹窗排版，不创建原生 Updater 资源，也不会触发下载、安装或重启。
 * 演示数据允许保留样例语言，避免把测试内容混入正式多语言资源。
 */
export const browserUpdateDialogFixture = {
  phase: 'available',
  currentVersion: '0.1.16',
  availableVersion: '0.2.1',
  notes: [
    '## Changes',
    '',
    '- Add direct links to the [Lore Client repository](https://github.com/ArnoChenFx/lore-client).',
    '- Improve update notes across multiple releases.',
    '',
    '### Earlier in 0.2.0',
    '',
    '- Refine `binary preview` performance and diagnostics.'
  ].join('\n'),
  downloadedBytes: 0,
  totalBytes: null,
  errorKind: null
} as const

/** 只有显式查询参数可以在纯前端环境启用更新弹窗，桌面应用始终使用真实 Updater。 */
export function shouldUseBrowserUpdateDialogFixture(
  applicationMode: ApplicationMode,
  search = typeof window === 'undefined' ? '' : window.location.search
): boolean {
  if (applicationMode !== 'browser-demo') return false
  return new URLSearchParams(search).get(UPDATE_DIALOG_FIXTURE_PARAMETER) === '1'
}
