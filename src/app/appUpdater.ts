import { getVersion } from '@tauri-apps/api/app'
import { relaunch } from '@tauri-apps/plugin-process'
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater'
import { useCallback, useEffect, useRef, useState } from 'react'

export type AppUpdatePhase =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'upToDate'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'installed'
  | 'error'

export interface AppUpdateState {
  phase: AppUpdatePhase
  currentVersion: string
  availableVersion: string
  notes: string
  downloadedBytes: number
  totalBytes: number | null
  errorKind: 'check' | 'install' | null
}

const EMPTY_UPDATE_STATE: AppUpdateState = {
  phase: 'idle',
  currentVersion: '',
  availableVersion: '',
  notes: '',
  downloadedBytes: 0,
  totalBytes: null,
  errorKind: null
}

/**
 * 把下载字节换算成稳定百分比。服务端可能不返回 Content-Length，此时返回 null，
 * 让界面显示不确定进度而不是伪造 0% 或除以零。
 */
export function calculateUpdateProgress(downloadedBytes: number, totalBytes: number | null): number | null {
  if (!totalBytes || totalBytes <= 0) return null
  return Math.min(100, Math.max(0, Math.round((downloadedBytes / totalBytes) * 100)))
}

/** Updater 忙碌期间禁止并发检查或重复安装，避免同时持有多个原生更新资源。 */
export function isUpdateBusy(phase: AppUpdatePhase): boolean {
  return phase === 'checking' || phase === 'downloading' || phase === 'installing' || phase === 'installed'
}

/** 自动检查必须同时等待偏好就绪，并确认当前构建具备原生更新能力。 */
export function shouldAutomaticallyCheckForUpdates(enabled: boolean, automaticallyCheck: boolean): boolean {
  return enabled && automaticallyCheck
}

/**
 * 管理 Tauri Updater 原生资源的完整生命周期。
 *
 * `enabled` 只在带正式发布配置的桌面构建中开启；浏览器演示和 Vite 开发模式不会
 * 请求 GitHub。`automaticallyCheck` 只控制启动后的延迟检查，不限制用户主动检查；
 * 自动检查也只发现更新，真正下载、安装与重启仍需用户明确确认。
 */
export function useAppUpdater(enabled: boolean, automaticallyCheck = true) {
  const [state, setState] = useState<AppUpdateState>(() => ({
    ...EMPTY_UPDATE_STATE,
    phase: enabled ? 'idle' : 'unsupported'
  }))
  const updateRef = useRef<Update | null>(null)
  const busyRef = useRef(false)

  const closeUpdateResource = useCallback(() => {
    const update = updateRef.current
    updateRef.current = null
    if (update) {
      // close() 只释放 Rust 侧资源；失败不影响下一次检查，因此不向用户制造额外错误。
      void update.close().catch((error: unknown) => console.warn('Failed to release the updater resource', error))
    }
  }, [])

  const checkForUpdates = useCallback(async () => {
    if (!enabled || busyRef.current) return
    busyRef.current = true
    setState((current) => ({ ...current, phase: 'checking', errorKind: null }))
    try {
      const currentVersion = await getVersion()
      const update = await check({ timeout: 15_000 })
      closeUpdateResource()
      if (!update) {
        setState({
          ...EMPTY_UPDATE_STATE,
          phase: 'upToDate',
          currentVersion
        })
        return
      }
      updateRef.current = update
      setState({
        ...EMPTY_UPDATE_STATE,
        phase: 'available',
        currentVersion: update.currentVersion || currentVersion,
        availableVersion: update.version,
        notes: update.body ?? ''
      })
    } catch (error) {
      // 原始插件错误只写入开发控制台；产品界面按语义错误类型显示本地化文案。
      console.error('Failed to check for application updates', error)
      setState((current) => ({ ...current, phase: 'error', errorKind: 'check' }))
    } finally {
      busyRef.current = false
    }
  }, [closeUpdateResource, enabled])

  const installUpdate = useCallback(async () => {
    const update = updateRef.current
    if (!enabled || !update || busyRef.current) return
    busyRef.current = true
    let downloadedBytes = 0
    let totalBytes: number | null = null
    setState((current) => ({
      ...current,
      phase: 'downloading',
      downloadedBytes: 0,
      totalBytes: null,
      errorKind: null
    }))
    try {
      await update.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === 'Started') {
          totalBytes = event.data.contentLength ?? null
          setState((current) => ({ ...current, totalBytes }))
          return
        }
        if (event.event === 'Progress') {
          downloadedBytes += event.data.chunkLength
          setState((current) => ({ ...current, downloadedBytes, totalBytes }))
          return
        }
        setState((current) => ({ ...current, phase: 'installing', downloadedBytes, totalBytes }))
      })
      setState((current) => ({ ...current, phase: 'installed' }))
      /*
       * Windows 安装器可能在此 Promise 完成前主动退出应用；其他平台完成后由
       * Process 插件重启，确保新二进制立即接管当前会话。
       */
      await relaunch()
    } catch (error) {
      console.error('Failed to install the application update', error)
      setState((current) => ({ ...current, phase: 'error', errorKind: 'install' }))
    } finally {
      busyRef.current = false
    }
  }, [enabled])

  useEffect(() => {
    setState((current) => ({
      ...current,
      phase: enabled ? (current.phase === 'unsupported' ? 'idle' : current.phase) : 'unsupported'
    }))
    if (!enabled) {
      closeUpdateResource()
      return
    }
    // 关闭自动检查只取消启动调度，不清理手动检查已获得的更新资源。
    if (!shouldAutomaticallyCheckForUpdates(enabled, automaticallyCheck)) return
    // 留出首屏水合时间，避免更新网络请求与仓库恢复竞争启动关键路径。
    const timeout = window.setTimeout(() => void checkForUpdates(), 2_000)
    return () => window.clearTimeout(timeout)
  }, [automaticallyCheck, checkForUpdates, closeUpdateResource, enabled])

  useEffect(() => closeUpdateResource, [closeUpdateResource])

  return {
    state,
    checkForUpdates,
    installUpdate
  }
}
