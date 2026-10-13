/** 按名称聚合的 Lore 事件解析器，供测试与诊断使用。 */
import { parseAuthIdentities } from './auth'
import { parseBranchDiff, parseBranchInfo, parseBranchLatest, parseBranches } from './branches'
import { parseLayers, parseLinkInfo, parseLinks } from './composition'
import { parseRepositoryConfigValue } from './config'
import { serverUrlFromRepositoryUrl } from './core'
import { parseRemoteRepositories } from './remote'
import { parseRepository } from './repositories'
import {
  parseChanges,
  parseFileHistory,
  parseRevisionBisect,
  parseRevisionFind,
  parseRevisionInfo,
  parseRevisions
} from './revisions'
import { normalizeDisplayPath } from './utils'
import { parseWorkingTreeDiffs } from './workspace'

/**
 * 仅供适配层单元测试使用的纯事件归一化入口。
 *
 * 组件和业务代码不要直接依赖这些函数，应始终调用 `loadRepositorySnapshot`。
 */
export const loreEventParsers = {
  parseRepository,
  parseBranches,
  parseBranchInfo,
  parseBranchLatest,
  parseBranchDiff,
  parseRevisionInfo,
  parseRevisionFind,
  parseRevisionBisect,
  parseAuthIdentities,
  parseChanges,
  parseWorkingTreeDiffs,
  parseFileHistory,
  parseRevisions,
  parseRemoteRepositories,
  parseLayers,
  parseLinks,
  parseLinkInfo,
  parseRepositoryConfigValue,
  serverUrlFromRepositoryUrl,
  normalizeDisplayPath
}
