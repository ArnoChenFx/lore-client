/** 修订与分支创建者的显示名解析，以及带缓存的作者名读写。 */
import type { LoreEvent, Repository } from '../../types'
import { invokeLogged } from '../logging'
import { runOperation } from './core'
import { readKnownLoreLabel, readMetadataValue, readString } from './utils'

/**
 * 批量收集 Revision 历史中可能是 userId 的作者 identity。
 *
 * userId 由 Auth 提供方定义，客户端没有稳定正则可以区分它和普通
 * 自由文本。因此沿用上游 CLI 的做法：去重后整批交给 Auth，只消费
 * 服务端实际返回的映射。
 */
function containsIdentityControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x1f || codePoint === 0x7f) return true
  }
  return false
}

export function collectRevisionAuthorIdentities(events: LoreEvent[]): string[] {
  const identities = new Set<string>()
  let currentMetadata: Map<string, unknown> | null = null

  /** 只提交该 Revision 最终会显示的 identity，与 `parseRevisions` 保持同一优先级。 */
  const appendCurrentIdentity = () => {
    if (!currentMetadata) return
    const identity = readKnownLoreLabel(currentMetadata.get('committed-by') ?? currentMetadata.get('created-by'))
    if (identity && identity.length <= 512 && !containsIdentityControlCharacter(identity)) {
      identities.add(identity)
    }
  }

  for (const event of events) {
    if (event.tagName === 'revisionHistoryEntry') {
      appendCurrentIdentity()
      currentMetadata = new Map()
    } else if (event.tagName === 'metadata' && currentMetadata) {
      const key = readString(event.data.key)
      if (key === 'committed-by' || key === 'created-by') {
        currentMetadata.set(key, readMetadataValue(event.data.value))
      }
    }
  }
  appendCurrentIdentity()
  return [...identities]
}

/**
 * Branch List 的 creator 与 Revision identity 使用同一种 Auth userId 语义。
 * 这里只收集可安全查询的真实值；缺失值和 Lore 哨兵继续交给界面本地化降级。
 */
export function collectBranchCreatorIdentities(events: LoreEvent[]): string[] {
  const identities = new Set<string>()
  for (const event of events) {
    if (event.tagName !== 'branchListEntry') continue
    const identity = readKnownLoreLabel(event.data.creator)
    if (identity && identity.length <= 512 && !containsIdentityControlCharacter(identity)) {
      identities.add(identity)
    }
  }
  return [...identities]
}

/**
 * 尽力把历史 userId 解析为 Auth 用户名。
 *
 * 这是不可依赖的显示增强：未绑定账户、离线、无权限、旧服务器
 * 或部分 ID 不存在时都返回已成功的子集，调用方继续使用原 identity。
 */
export async function resolveAuthorNames(
  repository: Repository,
  identityCandidates: readonly string[]
): Promise<Map<string, string>> {
  const identities = [...new Set(identityCandidates)]
  if (identities.length === 0) return new Map()
  /*
   * 持久化缓存是离线基线；在线或 Token Store 中的已验证资料只会覆盖它。
   * 缓存键包含稳定 Repository ID，不能把其他仓库或 Auth 域的相同 userId 串入。
   */
  const resolved = await loadCachedAuthorNames(repository.id, identities)

  if (repository.online) {
    try {
      const result = await runOperation('lore_auth_user_info', {
        repositoryPath: repository.path,
        userIds: identities
      })
      const remotelyResolved = new Map<string, string>()
      for (const event of result.events) {
        if (event.tagName !== 'authUserInfo') continue
        const userId = readString(event.data.id).trim()
        const username = readString(event.data.name).trim()
        if (
          userId &&
          username &&
          username !== userId &&
          username.length <= 512 &&
          !containsIdentityControlCharacter(username)
        ) {
          remotelyResolved.set(userId, username)
        }
      }
      await rememberAuthorNames(repository.id, remotelyResolved)
      for (const [userId, username] of remotelyResolved) resolved.set(userId, username)
      return resolved
    } catch {
      // 在线状态与 Auth 服务可用性并不等价；远端查询失败后继续尝试本地绑定缓存。
    }
  }

  /*
   * 离线时不制造必然失败的远端操作记录；只尝试仓库当前绑定账户的本地脱敏资料。
   * Rust 会把候选严格限制为绑定 userId，避免把当前账户名称套给其他历史作者。
   */
  try {
    const localResult = await runOperation('lore_auth_repository_local_user_info', {
      repositoryPath: repository.path,
      userIds: identities
    })
    const locallyResolved = new Map<string, string>()
    for (const event of localResult.events) {
      if (event.tagName !== 'authUserInfo') continue
      const userId = readString(event.data.id).trim()
      const username = readString(event.data.name).trim()
      if (
        userId &&
        username &&
        username !== userId &&
        username.length <= 512 &&
        !containsIdentityControlCharacter(username)
      ) {
        locallyResolved.set(userId, username)
      }
    }
    await rememberAuthorNames(repository.id, locallyResolved)
    for (const [userId, username] of locallyResolved) resolved.set(userId, username)
    return resolved
  } catch {
    return resolved
  }
}

type AuthorCacheEntry = {
  userId: string
  displayName: string
}

/** 独立缓存文件损坏或不可读不能阻断历史读取；失败时退回 Revision 原始 identity。 */
async function loadCachedAuthorNames(repositoryId: string, userIds: readonly string[]): Promise<Map<string, string>> {
  try {
    const entries = await invokeLogged<AuthorCacheEntry[]>('lore_revision_author_cache_get', {
      repositoryId,
      userIds
    })
    return new Map(entries.map((entry) => [entry.userId, entry.displayName]))
  } catch {
    return new Map()
  }
}

/** 只把 Auth 已确认的显示名交给 Rust；Token、JWT 与头像地址从不进入该 IPC。 */
async function rememberAuthorNames(repositoryId: string, resolvedNames: ReadonlyMap<string, string>): Promise<void> {
  if (resolvedNames.size === 0) return
  try {
    await invokeLogged('lore_revision_author_cache_store', {
      repositoryId,
      authors: [...resolvedNames].map(([userId, displayName]) => ({ userId, displayName }))
    })
  } catch {
    // 显示缓存属于尽力增强；写盘失败不能把成功的在线作者查询降级为操作失败。
  }
}
