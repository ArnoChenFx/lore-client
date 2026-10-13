/** 仓库配置与视图（View）的读取、更新与应用。 */
import type {
  LoreEvent,
  RepositoryConfiguration,
  RepositoryView,
  RepositoryViewApplyResult,
  RepositoryViewPreview
} from '../../types'
import { invokeCommand, runOperation, serverUrlFromRepositoryUrl } from './core'
import { readString } from './utils'

export interface RepositoryConfigValues extends RepositoryConfiguration {
  serverUrl?: string
}

/**
 * 仓库连接地址和作者身份属于项目本身，不能沿用上一次打开项目的全局输入值。
 * 两个键都通过 Rust 白名单读取；空字符串表示该仓库未配置对应字段。
 */
export async function loadRepositoryConfig(repositoryPath: string): Promise<RepositoryConfigValues> {
  const remoteResult = await runOperation('lore_repository_config_get', {
    repositoryPath,
    key: 'remote_url'
  })
  const identityResult = await runOperation('lore_repository_config_get', {
    repositoryPath,
    key: 'identity'
  })
  const remoteUrl = parseRepositoryConfigValue(remoteResult.events, 'remote_url')
  const identity = parseRepositoryConfigValue(identityResult.events, 'identity')
  return {
    remoteUrl: remoteUrl || undefined,
    serverUrl: remoteUrl ? serverUrlFromRepositoryUrl(remoteUrl) : undefined,
    identity: identity || undefined
  }
}

/**
 * 原子更新仓库配置中的两个白名单字段。
 *
 * 空字符串由 Rust 适配层解释为删除对应键；返回值来自落盘后的重新读取结果，
 * 调用方仍需刷新完整仓库快照以同步服务器地址和提交身份状态。
 */
export async function updateRepositoryConfig(
  repositoryPath: string,
  identity: string,
  remoteUrl: string
): Promise<RepositoryConfiguration> {
  return invokeCommand<RepositoryConfiguration>('lore_repository_config_update', {
    repositoryPath,
    identity,
    remoteUrl
  })
}

/** 读取当前 Instance 本地 View；不存在时返回空内容而不是伪造默认规则。 */
export async function loadRepositoryView(repositoryPath: string): Promise<RepositoryView> {
  return invokeCommand<RepositoryView>('lore_repository_view_get', { repositoryPath })
}

/** 只读取不可变 Revision Tree 和文件物化状态，不写 View 或工作区。 */
export async function previewRepositoryView(
  repositoryPath: string,
  revision: string,
  content: string
): Promise<RepositoryViewPreview> {
  return invokeCommand<RepositoryViewPreview>('lore_repository_view_preview', {
    repositoryPath,
    revision,
    content
  })
}

/** 原子替换 View 并通过 Lore Sync 完成实例物化状态协调。 */
export async function applyRepositoryView(
  repositoryPath: string,
  revision: string,
  content: string
): Promise<RepositoryViewApplyResult> {
  return invokeCommand<RepositoryViewApplyResult>('lore_repository_view_apply', {
    repositoryPath,
    revision,
    content
  })
}

export function parseRepositoryConfigValue(events: LoreEvent[], key: string): string {
  const event = events.find(
    (candidate) => candidate.tagName === 'repositoryConfigGet' && readString(candidate.data.key) === key
  )
  return readString(event?.data.value).trim()
}
