import { t } from '../i18n'
import { resolveSystemLanguagePreference } from '../i18n/systemLanguage'
import {
  DEFAULT_EXTERNAL_DIFF_TOOLS,
  DEFAULT_EXTERNAL_MERGE_TOOLS,
  DEFAULT_REPOSITORY_ICON_ID,
  isRepositoryAccentColor,
  isRepositoryIconId
} from '../shared/lib'
import type { ClientPreferences, WorkspaceLayout } from '../types'
import { invokeLogged, logError } from './logging'

/** 默认值保持升级前行为；最小值同时用于设置输入和磁盘偏好规范化（允许小数）。 */
export const DEFAULT_BINARY_PREVIEW_LIMIT_MIB = 20
export const MIN_BINARY_PREVIEW_LIMIT_MIB = 0.01

/*
 * 产品不设置最大值；这里只把超过 u64 字节计数能力的 MiB 值裁剪到可精确换算的
 * 技术边界。该值约 16 EiB，不构成正常使用中的产品限制，也不会暴露到输入控件。
 */
const MAX_BINARY_PREVIEW_LIMIT_MIB_BY_BYTE_COUNTER = 17_592_186_044_415

/** 偏好以最多两位小数的 MiB 保存，避免 JSON 中出现超出 u64 精度的字节换算值。 */
function roundPreviewLimitMib(value: number): number {
  return Math.round(value * 100) / 100
}

export const DEFAULT_CLIENT_PREFERENCES: ClientPreferences = {
  version: 5,
  theme: 'system',
  // 静态默认仍为简体中文；首次无偏好文件时由 resolveSystemLanguagePreference 覆盖。
  language: 'zh-CN',
  automaticallyCheckForUpdates: true,
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
  binaryPreviewLimitMib: DEFAULT_BINARY_PREVIEW_LIMIT_MIB,
  revisionHistoryLaneMode: 'flat',
  diff: {
    contextLines: 3,
    diffStyle: 'unified',
    expandFullFile: false,
    ignoreWhitespaceEol: false,
    ignoreWhitespaceInline: false
  },
  externalDiffTools: DEFAULT_EXTERNAL_DIFF_TOOLS,
  externalMergeTools: DEFAULT_EXTERNAL_MERGE_TOOLS,
  authAccountBindings: [],
  repositoryTabCustomizations: [],
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
  const repositoryTabCustomizations = Array.isArray(value?.repositoryTabCustomizations)
    ? value.repositoryTabCustomizations
        .filter((customization) => typeof customization?.repositoryPath === 'string')
        .map((customization) => {
          const repositoryPath = normalizePersistedRepositoryPath(customization.repositoryPath.trim()).slice(0, 4_096)
          const name =
            typeof customization.name === 'string'
              ? customization.name.replaceAll('\r', '').replaceAll('\n', '').trim().slice(0, 80)
              : ''
          const color = isRepositoryAccentColor(customization.color) ? customization.color : undefined
          const icon =
            isRepositoryIconId(customization.icon) && customization.icon !== DEFAULT_REPOSITORY_ICON_ID
              ? customization.icon
              : undefined
          return {
            repositoryPath,
            ...(name ? { name } : undefined),
            ...(color ? { color } : undefined),
            ...(icon ? { icon } : undefined)
          }
        })
        .filter(
          (customization) =>
            customization.repositoryPath.length > 0 &&
            !customization.repositoryPath.includes('\0') &&
            Boolean(customization.name || customization.color || customization.icon)
        )
        .filter(
          (customization, index, customizations) =>
            customizations.findIndex(
              (candidate) =>
                candidate.repositoryPath.toLocaleLowerCase('en-US') ===
                customization.repositoryPath.toLocaleLowerCase('en-US')
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
      kind: ['vscode', 'cursor', 'beyondCompare', 'p4merge', 'meld', 'custom'].includes(tool?.kind ?? '')
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
      /*
       * 旧偏好文件缺少布局字段时保持升级前的统一视图；未知值同样回退默认，
       * 避免未来外部编辑写入无效枚举后 Diff 面板失去布局语义。
       */
      diffStyle: diff?.diffStyle === 'split' ? 'split' : 'unified',
      /*
       * 展开全文是显式偏好，旧文件缺省时不自动开启，避免升级后突然请求
       * 完整文件内容改变既有阅读与网络开销。
       */
      expandFullFile: Boolean(diff?.expandFullFile),
      ignoreWhitespaceEol: Boolean(diff?.ignoreWhitespaceEol),
      ignoreWhitespaceInline: Boolean(diff?.ignoreWhitespaceInline)
    },
    externalDiffTools: normalizeTools(value?.externalDiffTools, DEFAULT_EXTERNAL_DIFF_TOOLS, 'diff'),
    externalMergeTools: normalizeTools(value?.externalMergeTools, DEFAULT_EXTERNAL_MERGE_TOOLS, 'merge'),
    defaultIdentity,
    language,
    // 旧偏好文件没有该字段时保持既有的启动检查行为。
    automaticallyCheckForUpdates:
      typeof value?.automaticallyCheckForUpdates === 'boolean'
        ? value.automaticallyCheckForUpdates
        : DEFAULT_CLIENT_PREFERENCES.automaticallyCheckForUpdates,
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
     * 偏好以最多两位小数的 MiB 保存。手工编辑产生的非有限值或非数字回退默认值，
     * 合法数字则裁剪到安全预算；0.01 MiB 的区间缩略图调试场景保留两位小数精度。
     */
    binaryPreviewLimitMib:
      typeof value?.binaryPreviewLimitMib === 'number' && Number.isFinite(value.binaryPreviewLimitMib)
        ? Math.max(
            MIN_BINARY_PREVIEW_LIMIT_MIB,
            Math.min(MAX_BINARY_PREVIEW_LIMIT_MIB_BY_BYTE_COUNTER, roundPreviewLimitMib(value.binaryPreviewLimitMib))
          )
        : DEFAULT_CLIENT_PREFERENCES.binaryPreviewLimitMib,
    /*
     * 平铺模式是软件默认视图。只有磁盘偏好明确保存 `topology` 时才进入
     * 多道图谱；旧配置缺少字段或外部调用传入未知值时统一回退默认单道模式。
     */
    revisionHistoryLaneMode: value?.revisionHistoryLaneMode === 'topology' ? 'topology' : 'flat',
    authAccountBindings,
    repositoryTabCustomizations,
    repositoryPaths,
    activeRepositoryPath
  }
}

/** 判断两份完整 Diff 偏好是否完全相同，包括读取参数与纯渲染参数。 */
function areDiffPreferencesEqual(left: ClientPreferences['diff'], right: ClientPreferences['diff']): boolean {
  return (
    left.contextLines === right.contextLines &&
    left.diffStyle === right.diffStyle &&
    left.expandFullFile === right.expandFullFile &&
    left.ignoreWhitespaceEol === right.ignoreWhitespaceEol &&
    left.ignoreWhitespaceInline === right.ignoreWhitespaceInline
  )
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
  await invokeLogged('lore_client_preferences_save', { preferences })
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
        logError('preferences', error)
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

    const stored = await invokeLogged<ClientPreferences | null>('lore_client_preferences_load')
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
  const normalizedPreferences = normalizePreferences({
    ...cachedPreferences,
    ...patch,
    workspaceLayout: patch.workspaceLayout
      ? {
          ...cachedPreferences.workspaceLayout,
          ...patch.workspaceLayout
        }
      : cachedPreferences.workspaceLayout
  })
  const nextPreferences: ClientPreferences = {
    ...normalizedPreferences,
    /*
     * Diff 订阅者会消费此对象；拖动分割线等无关布局更新经过完整规范化后仍复用
     * 旧引用，避免等值设置制造无意义渲染。读取 effect 另行投影三个 Lore patch
     * 参数，因此布局与全文展开的真实变化也不会误触发远程读取。
     */
    diff: areDiffPreferencesEqual(normalizedPreferences.diff, cachedPreferences.diff)
      ? cachedPreferences.diff
      : normalizedPreferences.diff
  }
  // 布局适配和 ResizeObserver 可能重复提交同一个值；无变化时不通知，避免
  // “偏好更新 → 组件同步 → 再次偏好更新”的无意义渲染与磁盘写入循环。
  if (JSON.stringify(nextPreferences) === JSON.stringify(cachedPreferences)) {
    return
  }
  cachedPreferences = nextPreferences
  notifyListeners()
  scheduleSave()
}
