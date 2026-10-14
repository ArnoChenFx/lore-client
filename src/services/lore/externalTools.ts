/** 外部 Diff/Merge 工具的探测与启动，以及补丁保存。 */
import { isTauri } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'

import { t } from '../../i18n'
import type {
  AvailableExternalTool,
  ExternalDiffLaunchResult,
  ExternalDiffRequest,
  ExternalDiffToolPreference,
  ExternalMergeRequest
} from '../../types'
import { invokeCommand } from './core'

/**
 * 使用用户配置的原生可执行文件比较两个真实文件版本。
 *
 * 请求中的参数模板保持结构化数组；Rust 负责校验仓库路径、物化不可变版本并
 * 直接启动进程，前端不拼接命令行或 Shell 文本。
 */
export async function openExternalDiff(request: ExternalDiffRequest): Promise<ExternalDiffLaunchResult> {
  return invokeCommand<ExternalDiffLaunchResult>('lore_open_external_diff', {
    repositoryPath: request.repositoryPath,
    tool: request.tool,
    before: request.before,
    after: request.after
  })
}

/** 由 Rust 使用与启动阶段相同的规则探测显式路径和系统 PATH。 */
export async function detectExternalTools(tools: ExternalDiffToolPreference[]): Promise<AvailableExternalTool[]> {
  if (!isTauri()) return []
  return invokeCommand<AvailableExternalTool[]>('lore_detect_external_tools', { tools })
}

/** 启动四路外部 Merge；共同祖先解析与历史内容物化全部留在 Rust 边界。 */
export async function openExternalMerge(request: ExternalMergeRequest): Promise<ExternalDiffLaunchResult> {
  return invokeCommand<ExternalDiffLaunchResult>('lore_open_external_merge', { ...request })
}

/**
 * 保证补丁保存路径带 `.patch` 或 `.diff` 扩展名；Rust 端只接受这两种扩展名。
 * 原生对话框在部分平台不会自动补全过滤器扩展名，因此这里统一补上 `.patch`。
 */
export function withPatchExtension(path: string): string {
  return /\.(patch|diff)$/i.test(path) ? path : `${path}.patch`
}

export interface PatchDestination {
  destinationPath: string
  replaceExisting: boolean
}

/**
 * 对话框返回的路径才是用户看到并确认过的目标；补全扩展名后的路径没有经过确认，
 * 因此只有未补全时才允许覆盖已存在的文件。
 */
export function resolvePatchDestination(selectedPath: string): PatchDestination {
  const destinationPath = withPatchExtension(selectedPath)
  return { destinationPath, replaceExisting: destinationPath === selectedPath }
}

/** 通过原生保存对话框选择位置，并由 Rust 完成补丁写入。 */
export async function savePatchFile(suggestedName: string, patch: string): Promise<string | null> {
  const selectedPath = await save({
    title: t('saveWorkspacePatch'),
    defaultPath: suggestedName.endsWith('.patch') ? suggestedName : `${suggestedName}.patch`,
    filters: [{ name: t('unifiedDiffPatch'), extensions: ['patch', 'diff'] }]
  })
  if (!selectedPath) {
    return null
  }
  const { destinationPath, replaceExisting } = resolvePatchDestination(selectedPath)
  await invokeCommand<void>('lore_write_patch_file', { destinationPath, patch, replaceExisting })
  return destinationPath
}

/** 选择外部 Diff/Merge 工具的可执行文件；命令名仍可直接在设置输入框中填写。 */
export async function selectExternalDiffExecutable(): Promise<string | null> {
  if (!isTauri()) {
    throw new Error(t('browserPreviewAccessLocalFiles_919d'))
  }
  const selection = await open({
    directory: false,
    multiple: false,
    title: t('chooseExternalDiffExecutable')
  })
  return typeof selection === 'string' ? selection : null
}
