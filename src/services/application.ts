import { isTauri } from '@tauri-apps/api/core'

import { invokeLogged } from './logging'

/** 浏览器演示与桌面客户端共享的公开项目仓库地址。 */
export const PROJECT_REPOSITORY_URL = 'https://github.com/ArnoChenFx/lore-client'

/** 更新弹窗使用的公开发布页地址。 */
export const PROJECT_RELEASES_URL = `${PROJECT_REPOSITORY_URL}/releases`

/**
 * 让桌面壳通过固定 Rust 命令打开仓库，避免当前 WebView 被外部页面替换。
 *
 * 浏览器演示环境继续使用链接自身的 href，因此这里无需模拟成功或调用 window.open。
 */
export async function openProjectRepository(): Promise<void> {
  if (!isTauri()) return
  await invokeLogged('application_open_project_repository')
}

/** 通过桌面壳打开固定 Releases 页面，避免把 WebView 导航到外部站点。 */
export async function openProjectReleases(): Promise<void> {
  if (!isTauri()) return
  await invokeLogged('application_open_project_releases')
}
