import { invoke } from '@tauri-apps/api/core'

import { t } from '../i18n'
import { resolveSystemLanguagePreference } from '../i18n/systemLanguage'
import { DEFAULT_EXTERNAL_DIFF_TOOLS, DEFAULT_EXTERNAL_MERGE_TOOLS } from '../shared/lib'
import type { ClientPreferences, WorkspaceLayout } from '../types'

export const DEFAULT_CLIENT_PREFERENCES: ClientPreferences = {
  version: 3,
  theme: 'system',
  // 静态默认仍为简体中文；首次无偏好文件时由 resolveSystemLanguagePreference 覆盖。
  language: 'zh-CN',
  defaultIdentity: '',
  workspaceLayout: {
    sidebarWidth: 244,
    inspectorWidth: 520
  },
  inspectorTab: 'overview',
  localChangesView: 'tree',
  localChangesStageSplit: 0.58,
  localChangesDiffVisible: true,
  revisionChangesView: 'tree',
  revisionChangesBrowserWidth: 220,
  revisionChangesDiffVisible: true,
  binaryDiffVisible: true,
  revisionHistoryLaneMode: 'flat',
  diff: {
    contextLines: 3,
    ignoreWhitespaceEol: false,
    ignoreWhitespaceInline: false
  },
  externalDiffTools: DEFAULT_EXTERNAL_DIFF_TOOLS,
  externalMergeTools: DEFAULT_EXTERNAL_MERGE_TOOLS,
  authAccountBindings: [],
  repositoryPaths: [],
  activeRepositoryPath: null
}

const LEGACY_KEYS = {
  theme: 'lore-client.theme',
  workspaceLayout: 'lore-client.workspace-layout',
  inspectorTab: 'lore-client.inspector-tab',
  localChangesView: 'lore-client.local-changes-view',
  localChangesStageSplit: 'lore-client.local-changes-stage-split',
  revisionChangesView: 'lore-client.revision-changes-view',
  revisionChangesBrowserWidth: 'lore-client.revision-changes-browser-width',
  repositoryPaths: 'lore-client.recent-repositories'
} as const

type PreferencesListener = (preferences: ClientPreferences, ready: boolean, error: string | null) => void

let cachedPreferences = DEFAULT_CLIENT_PREFERENCES
let preferencesReady = !isTauriRuntime()
let initialization: Promise<ClientPreferences> | null = null
let saveTimer: number | null = null
let saveQueue = Promise.resolve()
let preferencesError: string | null = null
const listeners = new Set<PreferencesListener>()

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 偏好文件只保存适合展示和再次打开的普通路径，不保留 Windows `\\?\` 前缀。 */
function normalizePersistedRepositoryPath(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) {
    return `\\\\${path.slice('\\\\?\\UNC\\'.length)}`
  }
  return path.startsWith('\\\\?\\') ? path.slice(4) : path
}

function normalizePreferences(value: Partial<ClientPreferences> | null | undefined): ClientPreferences {
  const layout = value?.workspaceLayout
  const diff = value?.diff
  const repositoryPaths = Array.isArray(value?.repositoryPaths)
    ? value.repositoryPaths
        .filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
        .map((path) => normalizePersistedRepositoryPath(path.trim()))
        .filter(
          (path, index, paths) =>
            paths.findIndex((candidate) => candidate.toLocaleLowerCase() === path.toLocaleLowerCase()) === index
        )
    : []
  const activeRepositoryPath =
    typeof value?.activeRepositoryPath === 'string'
      ? normalizePersistedRepositoryPath(value.activeRepositoryPath.trim()) || null
      : null
  const authAccountBindings = Array.isArray(value?.authAccountBindings)
    ? value.authAccountBindings
        .filter(
          (binding) =>
            typeof binding?.repositoryPath === 'string' &&
            typeof binding?.authUrl === 'string' &&
            typeof binding?.userId === 'string'
        )
        .map((binding) => ({
          repositoryPath: normalizePersistedRepositoryPath(binding.repositoryPath.trim()).slice(0, 4_096),
          authUrl: binding.authUrl.trim().slice(0, 2_048),
          userId: binding.userId.trim().slice(0, 512)
        }))
        .filter(
          (binding) =>
            binding.repositoryPath.length > 0 &&
            binding.authUrl.length > 0 &&
            binding.userId.length > 0 &&
            !binding.authUrl.includes('\0') &&
            !binding.userId.includes('\0')
        )
        .filter(
          (binding, index, bindings) =>
            bindings.findIndex(
              (candidate) => candidate.repositoryPath.toLocaleLowerCase() === binding.repositoryPath.toLocaleLowerCase()
            ) === index
        )
        .slice(0, 256)
    : []
  const defaultIdentity =
    typeof value?.defaultIdentity === 'string' ? value.defaultIdentity.replaceAll('\r', '').replaceAll('\n', '') : ''
  const language = value?.language === 'en-US' ? 'en-US' : 'zh-CN'
  const normalizeTools = (
    tools: ClientPreferences['externalDiffTools'] | undefined,
    fallback: ClientPreferences['externalDiffTools'],
    mode: 'diff' | 'merge'
  ) => {
    const source = Array.isArray(tools) ? tools : fallback
    const normalized = source.slice(0, 32).map((tool, index) => ({
      id:
        typeof tool?.id === 'string' && tool.id.trim()
          ? tool.id.trim().slice(0, 128)
          : `${mode}-${tool?.kind ?? 'custom'}-${index}`,
      kind: ['vscode', 'cursor', 'beyondCompare', 'p4merge', 'custom'].includes(tool?.kind ?? '')
        ? tool.kind
        : ('custom' as const),
      name: typeof tool?.name === 'string' ? tool.name.slice(0, 128) : '',
      executable: typeof tool?.executable === 'string' ? tool.executable.slice(0, 4_096) : '',
      arguments: Array.isArray(tool?.arguments)
        ? tool.arguments.filter((argument): argument is string => typeof argument === 'string').slice(0, 64)
        : mode === 'diff'
          ? ['{before}', '{after}']
          : ['{remote}', '{local}', '{base}', '{merged}'],
      primary: Boolean(tool?.primary)
    }))
    // 同一列表最多保留一个主工具；如果用户数据重复，稳定保留第一项。
    let primarySeen = false
    return normalized.map((tool) => {
      const primary = tool.primary && !primarySeen
      primarySeen ||= primary
      return { ...tool, primary }
    })
  }
  return {
    ...DEFAULT_CLIENT_PREFERENCES,
    ...value,
    version: DEFAULT_CLIENT_PREFERENCES.version,
    workspaceLayout: {
      ...DEFAULT_CLIENT_PREFERENCES.workspaceLayout,
      ...layout
    },
    diff: {
      contextLines:
        typeof diff?.contextLines === 'number' && Number.isFinite(diff.contextLines)
          ? Math.max(0, Math.min(100, Math.round(diff.contextLines)))
          : DEFAULT_CLIENT_PREFERENCES.diff.contextLines,
      ignoreWhitespaceEol: Boolean(diff?.ignoreWhitespaceEol),
      ignoreWhitespaceInline: Boolean(diff?.ignoreWhitespaceInline)
    },
    externalDiffTools: normalizeTools(value?.externalDiffTools, DEFAULT_EXTERNAL_DIFF_TOOLS, 'diff'),
    externalMergeTools: normalizeTools(value?.externalMergeTools, DEFAULT_EXTERNAL_MERGE_TOOLS, 'merge'),
    defaultIdentity,
    language,
    localChangesDiffVisible:
      typeof value?.localChangesDiffVisible === 'boolean'
        ? value.localChangesDiffVisible
        : DEFAULT_CLIENT_PREFERENCES.localChangesDiffVisible,
    revisionChangesDiffVisible:
      typeof value?.revisionChangesDiffVisible === 'boolean'
        ? value.revisionChangesDiffVisible
        : DEFAULT_CLIENT_PREFERENCES.revisionChangesDiffVisible,
    /*
     * 旧偏好文件没有该字段时继续显示二进制 Diff，避免升级后无提示地隐藏
     * 用户原本可见的图片、PDF、CSV 与模型预览。
     */
    binaryDiffVisible:
      typeof value?.binaryDiffVisible === 'boolean'
        ? value.binaryDiffVisible
        : DEFAULT_CLIENT_PREFERENCES.binaryDiffVisible,
    /*
     * 平铺模式是软件默认视图。只有磁盘偏好明确保存 `topology` 时才进入
     * 多道图谱；旧配置缺少字段或外部调用传入未知值时统一回退默认单道模式。
     */
    revisionHistoryLaneMode: value?.revisionHistoryLaneMode === 'topology' ? 'topology' : 'flat',
    authAccountBindings,
    repositoryPaths,
    activeRepositoryPath
  }
}

function notifyListeners(): void {
  for (const listener of listeners) {
    listener(cachedPreferences, preferencesReady, preferencesError)
  }
}

function readPreferencesError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error && 'message' in error) {
    return String(error.message)
  }
  return t('unableWriteClientPreferencesFile_efe0')
}

/**
 * 首次升级时只读取旧浏览器存储一次，并在磁盘文件保存成功后删除旧键。
 *
 * 该函数不是持续持久化路径；迁移完成后的所有写入只进入原生配置文件。
 */
function readLegacyPreferences(): Partial<ClientPreferences> {
  if (typeof window === 'undefined') return {}
  const result: Partial<ClientPreferences> = {}
  const theme = localStorage.getItem(LEGACY_KEYS.theme)
  if (theme === 'system' || theme === 'dark' || theme === 'light') {
    result.theme = theme
  }

  try {
    const layout = JSON.parse(
      localStorage.getItem(LEGACY_KEYS.workspaceLayout) ?? 'null'
    ) as Partial<WorkspaceLayout> | null
    if (layout && typeof layout.sidebarWidth === 'number' && typeof layout.inspectorWidth === 'number') {
      result.workspaceLayout = {
        sidebarWidth: layout.sidebarWidth,
        inspectorWidth: layout.inspectorWidth
      }
    }
  } catch {
    // 损坏的旧值只会被丢弃，不能阻断新的磁盘偏好文件创建。
  }

  const inspectorTab = localStorage.getItem(LEGACY_KEYS.inspectorTab)
  if (inspectorTab === 'overview' || inspectorTab === 'changes' || inspectorTab === 'tree') {
    result.inspectorTab = inspectorTab
  }
  const localView = localStorage.getItem(LEGACY_KEYS.localChangesView)
  if (localView === 'flat' || localView === 'tree') {
    result.localChangesView = localView
  }
  const revisionView = localStorage.getItem(LEGACY_KEYS.revisionChangesView)
  if (revisionView === 'flat' || revisionView === 'tree') {
    result.revisionChangesView = revisionView
  }

  const stageSplit = Number(localStorage.getItem(LEGACY_KEYS.localChangesStageSplit))
  if (Number.isFinite(stageSplit) && stageSplit >= 0.15 && stageSplit <= 0.85) {
    result.localChangesStageSplit = stageSplit
  }
  const browserWidth = Number(localStorage.getItem(LEGACY_KEYS.revisionChangesBrowserWidth))
  if (Number.isFinite(browserWidth) && browserWidth > 0) {
    result.revisionChangesBrowserWidth = browserWidth
  }

  try {
    const paths = JSON.parse(localStorage.getItem(LEGACY_KEYS.repositoryPaths) ?? '[]')
    if (Array.isArray(paths)) {
      result.repositoryPaths = paths.filter((path): path is string => typeof path === 'string')
      result.activeRepositoryPath = result.repositoryPaths[0] ?? null
    }
  } catch {
    // 旧会话损坏时从空会话开始，之后仍会写入合法文件。
  }
  return result
}

function removeLegacyPreferences(): void {
  if (typeof window === 'undefined') return
  for (const key of Object.values(LEGACY_KEYS)) {
    localStorage.removeItem(key)
  }
}

async function savePreferencesNow(preferences: ClientPreferences): Promise<void> {
  await invoke('lore_client_preferences_save', { preferences })
}

function scheduleSave(): void {
  if (!isTauriRuntime() || !preferencesReady) return
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer)
  }
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    const snapshot = cachedPreferences
    // 一次磁盘写入失败不能永久阻塞后续保存；错误仍会明确输出供桌面日志诊断。
    saveQueue = saveQueue
      .catch(() => undefined)
      .then(() => savePreferencesNow(snapshot))
      .then(() => {
        if (preferencesError) {
          preferencesError = null
          notifyListeners()
        }
      })
      .catch((error: unknown) => {
        preferencesError = readPreferencesError(error)
        notifyListeners()
        console.error('Failed to save client preferences', error)
      })
  }, 120)
}

export function getClientPreferences(): ClientPreferences {
  return cachedPreferences
}

export function areClientPreferencesReady(): boolean {
  return preferencesReady
}

export function subscribeClientPreferences(listener: PreferencesListener): () => void {
  listeners.add(listener)
  listener(cachedPreferences, preferencesReady, preferencesError)
  // App 启动链路会单独处理并向用户展示初始化错误；订阅者只负责保持状态同步。
  void initializeClientPreferences().catch(() => undefined)
  return () => listeners.delete(listener)
}

export async function initializeClientPreferences(): Promise<ClientPreferences> {
  if (initialization) return initialization
  initialization = (async () => {
    if (!isTauriRuntime()) {
      /*
       * 浏览器演示没有磁盘偏好文件，等同首次打开：按操作系统语言选默认界面语言。
       * 用户在会话内切换语言仍只留在内存，不会伪造落盘成功。
       */
      cachedPreferences = normalizePreferences({
        ...DEFAULT_CLIENT_PREFERENCES,
        language: resolveSystemLanguagePreference()
      })
      preferencesReady = true
      notifyListeners()
      return cachedPreferences
    }

    const stored = await invoke<ClientPreferences | null>('lore_client_preferences_load')
    if (stored) {
      cachedPreferences = normalizePreferences(stored)
      removeLegacyPreferences()
    } else {
      cachedPreferences = normalizePreferences({
        ...DEFAULT_CLIENT_PREFERENCES,
        // 尚无 client-preferences.json：按系统语言选定后再落盘，避免下次启动再次探测。
        language: resolveSystemLanguagePreference(),
        ...readLegacyPreferences()
      })
      // 只有偏好文件落盘成功后才清理旧键，避免升级中断导致设置丢失。
      await savePreferencesNow(cachedPreferences)
      removeLegacyPreferences()
    }
    preferencesReady = true
    notifyListeners()
    return cachedPreferences
  })()
  return initialization
}

export function updateClientPreferences(patch: Partial<ClientPreferences>): void {
  const nextPreferences = normalizePreferences({
    ...cachedPreferences,
    ...patch,
    workspaceLayout: patch.workspaceLayout
      ? {
          ...cachedPreferences.workspaceLayout,
          ...patch.workspaceLayout
        }
      : cachedPreferences.workspaceLayout
  })
  // 布局适配和 ResizeObserver 可能重复提交同一个值；无变化时不通知，避免
  // “偏好更新 → 组件同步 → 再次偏好更新”的无意义渲染与磁盘写入循环。
  if (JSON.stringify(nextPreferences) === JSON.stringify(cachedPreferences)) {
    return
  }
  cachedPreferences = nextPreferences
  notifyListeners()
  scheduleSave()
}
