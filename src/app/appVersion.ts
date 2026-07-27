import { getVersion } from '@tauri-apps/api/app'

import { logWarning } from '../services/logging'

/**
 * 从 Tauri 读取当前正在运行的应用版本。
 *
 * About 页也会出现在浏览器演示环境中，此时原生 IPC 不可用。这里将该环境差异收敛
 * 为 null，由界面显示明确的不可用占位，不使用 package.json 版本伪装正在运行的程序。
 */
export async function loadApplicationVersion(): Promise<string | null> {
  try {
    const version = (await getVersion()).trim()
    return version || null
  } catch (error) {
    // 原生调用失败只进入开发日志；About 页仍可继续展示 Lore Core 等诊断信息。
    logWarning('application-version', error)
    return null
  }
}
