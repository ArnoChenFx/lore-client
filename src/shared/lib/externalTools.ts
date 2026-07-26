import type {
  ChangeFile,
  ExternalDiffRequest,
  ExternalDiffSide,
  ExternalDiffToolKind,
  ExternalDiffToolPreference,
  ExternalMergeRequest,
  ExternalMergeToolPreference
} from '../../types'

/** 生成不依赖随机数的稳定标识，让菜单 key 与主工具选择保持一致。 */
function presetId(mode: 'diff' | 'merge', kind: ExternalDiffToolKind) {
  return `${mode}-${kind}`
}

/** 编辑自定义工具时使用的空白骨架。 */
export function createCustomExternalTool(mode: 'diff' | 'merge'): ExternalDiffToolPreference {
  return {
    id: `${mode}-custom-${Date.now()}`,
    kind: 'custom',
    name: '',
    executable: '',
    arguments: mode === 'diff' ? ['{before}', '{after}'] : ['{remote}', '{local}', '{base}', '{merged}'],
    primary: false
  }
}

/**
 * 返回常见 Diff/Merge 工具的 PATH 命令和参数预设。
 *
 * 命令名由 Rust 按系统 PATH（Windows 同时遵循 PATHEXT）解析；用户仍可用绝对路径
 * 覆盖。参数以数组保存，路径和标题不经过 Shell 拼接。
 */
export function externalToolPreset(
  mode: 'diff' | 'merge',
  kind: Exclude<ExternalDiffToolKind, 'none' | 'custom'>
): ExternalDiffToolPreference {
  const shared = {
    id: presetId(mode, kind),
    kind,
    primary: kind === 'beyondCompare'
  }
  if (mode === 'diff') {
    if (kind === 'vscode') {
      return {
        ...shared,
        name: 'Visual Studio Code',
        executable: 'code',
        arguments: ['--wait', '--diff', '{before}', '{after}']
      }
    }
    if (kind === 'cursor') {
      return {
        ...shared,
        name: 'Cursor',
        executable: 'cursor',
        arguments: ['--wait', '--diff', '{before}', '{after}']
      }
    }
    if (kind === 'beyondCompare') {
      return {
        ...shared,
        name: 'Beyond Compare',
        executable: 'BCompare',
        arguments: ['/lefttitle={beforeLabel}', '/righttitle={afterLabel}', '{before}', '{after}']
      }
    }
    return {
      ...shared,
      name: 'P4Merge',
      executable: 'p4merge',
      arguments: ['-nl', '{beforeLabel}', '-nr', '{afterLabel}', '{before}', '{after}']
    }
  }

  if (kind === 'vscode') {
    return {
      ...shared,
      name: 'Visual Studio Code',
      executable: 'code',
      arguments: ['--wait', '--merge', '{remote}', '{local}', '{base}', '{merged}']
    }
  }
  if (kind === 'cursor') {
    return {
      ...shared,
      name: 'Cursor',
      executable: 'cursor',
      arguments: ['--wait', '--merge', '{remote}', '{local}', '{base}', '{merged}']
    }
  }
  if (kind === 'beyondCompare') {
    return {
      ...shared,
      name: 'Beyond Compare',
      executable: 'BCompare',
      arguments: ['{remote}', '{local}', '{base}', '{merged}']
    }
  }
  return {
    ...shared,
    name: 'P4Merge',
    executable: 'p4merge',
    arguments: ['{base}', '{remote}', '{local}', '{merged}']
  }
}

export const DEFAULT_EXTERNAL_DIFF_TOOLS: ExternalDiffToolPreference[] = (
  ['beyondCompare', 'cursor', 'p4merge', 'vscode'] as const
).map((kind) => externalToolPreset('diff', kind))

export const DEFAULT_EXTERNAL_MERGE_TOOLS: ExternalMergeToolPreference[] = (
  ['beyondCompare', 'cursor', 'p4merge', 'vscode'] as const
).map((kind) => externalToolPreset('merge', kind))

/** 返回单个 Diff 工具预设，供配置测试与编辑器复用。 */
export function externalDiffToolPreset(kind: Exclude<ExternalDiffToolKind, 'none'>): ExternalDiffToolPreference {
  return kind === 'custom' ? createCustomExternalTool('diff') : externalToolPreset('diff', kind)
}

/** 名称、命令和对应模式必需的路径模板完整时，配置才有资格进入 Rust 探测。 */
export function isExternalToolConfigured(tool: ExternalDiffToolPreference, mode: 'diff' | 'merge' = 'diff'): boolean {
  const template = tool.arguments.join('\n')
  const placeholders = mode === 'diff' ? ['{before}', '{after}'] : ['{base}', '{local}', '{remote}', '{merged}']
  return (
    tool.kind !== 'none' &&
    tool.name.trim().length > 0 &&
    tool.executable.trim().length > 0 &&
    placeholders.every((placeholder) => template.includes(placeholder))
  )
}

export const isExternalDiffToolConfigured = (tool: ExternalDiffToolPreference) => isExternalToolConfigured(tool, 'diff')

/** 主工具置顶，其余保持用户列表顺序。 */
export function orderExternalTools<T extends ExternalDiffToolPreference>(tools: T[]): T[] {
  return [...tools].sort((left, right) => Number(right.primary) - Number(left.primary))
}

/** 统一生成仓库相对路径，避免根目录文件出现 `./` 前缀。 */
function changePath(file: ChangeFile): string {
  return file.path && file.path !== '.' ? `${file.path}/${file.name}` : file.name
}

function revisionSide(path: string, revision: string, label: string): ExternalDiffSide {
  return { kind: 'revision', path, revision, label }
}

function emptySide(path: string, label: string): ExternalDiffSide {
  return { kind: 'empty', path, label }
}

/** 构建当前 Revision 与工作区之间的比较。 */
export function createWorkspaceExternalDiffRequest(
  repositoryPath: string,
  workspaceRevision: string,
  file: ChangeFile,
  tool: ExternalDiffToolPreference,
  labels: { before: string; after: string }
): ExternalDiffRequest {
  const path = changePath(file)
  const beforePath = file.previousPath || path
  return {
    repositoryPath,
    tool,
    before:
      file.status === 'added'
        ? emptySide(beforePath, labels.before)
        : revisionSide(beforePath, workspaceRevision, labels.before),
    after:
      file.status === 'deleted'
        ? emptySide(path, labels.after)
        : {
            kind: 'workspace',
            path,
            label: labels.after
          }
  }
}

/** 构建两个不可变 Revision（或空树）之间的比较。 */
export function createRevisionExternalDiffRequest(
  repositoryPath: string,
  sourceRevision: string | null,
  targetRevision: string,
  file: ChangeFile,
  tool: ExternalDiffToolPreference,
  labels: { before: string; after: string }
): ExternalDiffRequest {
  const path = changePath(file)
  const beforePath = file.previousPath || path
  return {
    repositoryPath,
    tool,
    before:
      file.status === 'added' || !sourceRevision
        ? emptySide(beforePath, labels.before)
        : revisionSide(beforePath, sourceRevision, labels.before),
    after: file.status === 'deleted' ? emptySide(path, labels.after) : revisionSide(path, targetRevision, labels.after)
  }
}

/** Rust 负责从真实 Revision 拓扑解析 BASE，并物化三侧历史内容。 */
export function createExternalMergeRequest(
  repositoryPath: string,
  file: ChangeFile,
  tool: ExternalMergeToolPreference,
  currentRevision: string,
  incomingRevision: string,
  labels: ExternalMergeRequest['labels']
): ExternalMergeRequest {
  return {
    repositoryPath,
    tool,
    path: changePath(file),
    currentRevision,
    incomingRevision,
    labels
  }
}
