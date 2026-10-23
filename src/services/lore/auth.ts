/** 认证身份管理、登录登出、仓库与账号绑定，以及远端认证事件。 */
import { isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { UnlistenFn } from '@tauri-apps/api/event'

import type { OperationContext, LoreAuthIdentity, LoreEvent, LoreOperationResult } from '../../types'
import { invokeLogged } from '../logging'
import { createOperationContext, withOperationRequest } from '../operationRequests'
import { runOperation } from './core'
import { readNumber, readString } from './utils'

/** Rust 侧检测到凭据缺失/失效的远端操作失败时广播的负载。 */
export interface RemoteAuthenticationRequiredEvent {
  /** 触发信号的 Lore 操作名，仅用于诊断展示。 */
  operation: string
}

/** Rust 侧实时转发的交互登录确认信息（Lore `AuthUrl` 事件的负载）。 */
export interface LoreAuthUrlEvent {
  /** 触发登录的 Lore 操作 ID，与同操作的 dismiss 信号对应。 */
  operationId: string
  /** 触发登录的 Lore 操作名，仅用于诊断展示。 */
  operation: string
  /** 登录页面地址；浏览器模式下 Lore 已自行打开，这里仅供用户核对。 */
  url: string
  /** 用户要在登录页核对或输入的确认代码；本次登录不要求代码时为空字符串。 */
  userCode: string
}

/** 某次登录操作结束、对应 AuthUrl 提示应当收起的信号负载。 */
export interface LoreAuthUrlDismissEvent {
  operationId: string
}

/**
 * 订阅“远端需要重新认证”全局信号。
 *
 * 远端在连接建立阶段缺凭据时会把认证失败报成 `NotConnected` 加
 * "Not authenticated" 文本，Status 又只会给出 remoteAvailable=0，前端无法从
 * 快照区分离线与凭据失效；因此由 Rust 在 run_operation 汇聚点检测并在命中时
 * 广播本信号，前端据此探测服务器并打开全局重新认证弹窗。
 */
export async function subscribeRemoteAuthenticationRequired(
  listener: (event: RemoteAuthenticationRequiredEvent) => void
): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined
  return listen<RemoteAuthenticationRequiredEvent>('lore://remote-authentication-required', (event) =>
    listener(event.payload)
  )
}

/**
 * 订阅交互登录的确认代码提示。
 *
 * 操作结果里的 AuthUrl 事件要等登录结束才返回，而确认代码必须在登录进行中展示，
 * 因此由 Rust 在事件回调处实时转发；登录操作没有进度快照、全局操作流不会开流，
 * 结束信号只能走配对的 dismiss 通道，不能依赖操作流的 terminal 事件。
 */
export async function subscribeAuthUrl(listener: (event: LoreAuthUrlEvent) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined
  return listen<LoreAuthUrlEvent>('lore://auth-url', (event) => listener(event.payload))
}

/** 订阅与 {@link subscribeAuthUrl} 配对的收起信号（按 operationId 对应）。 */
export async function subscribeAuthUrlDismiss(listener: (event: LoreAuthUrlDismissEvent) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined
  return listen<LoreAuthUrlDismissEvent>('lore://auth-url-dismiss', (event) => listener(event.payload))
}

/**
 * 列出脱敏账户，并用 Auth 服务签发的本地 JWT 补充显示名。
 *
 * Auth List 会为同一账户返回身份根条目和多个资源授权条目，因此按认证端点分组并对
 * userId 去重。显示名解析只是增强信息：某个端点的 Token 已过期、损坏或暂时不可读
 * 时仍返回基础账户，界面继续明确回退到不可变 userId。
 */
export async function listAuthIdentities(operationContext?: OperationContext): Promise<LoreAuthIdentity[]> {
  return withOperationRequest(operationContext ?? createOperationContext(null), async (requestContext) => {
    const result = await runOperation('lore_auth_list', {}, requestContext)
    const identities = parseAuthIdentities(result.events)
    const identitiesByAuthUrl = new Map<string, Set<string>>()
    for (const identity of identities) {
      const userIds = identitiesByAuthUrl.get(identity.authUrl) ?? new Set<string>()
      userIds.add(identity.userId)
      identitiesByAuthUrl.set(identity.authUrl, userIds)
    }

    const resolvedNames = new Map<string, string>()
    await Promise.all(
      [...identitiesByAuthUrl].map(async ([authUrl, userIds]) => {
        try {
          const userInfo = await runOperation(
            'lore_auth_local_user_info',
            {
              authUrl,
              userIds: [...userIds]
            },
            requestContext
          )
          for (const event of userInfo.events) {
            if (event.tagName !== 'authUserInfo') continue
            const userId = readString(event.data.id)
            const displayName = readString(event.data.name)
            if (userId && displayName && displayName !== userId) {
              resolvedNames.set(authIdentityKey(authUrl, userId), displayName)
            }
          }
        } catch {
          /*
           * 名称解析不能改变账户可用性。失败详情已经由底层操作流记录；这里保留账户 ID，
           * 让退出登录、仓库绑定和重新认证仍然可用。
           */
        }
      })
    )

    return identities.map((identity) => ({
      ...identity,
      displayName: resolvedNames.get(authIdentityKey(identity.authUrl, identity.userId))
    }))
  })
}

/** 由 Lore/Rust 打开系统浏览器并完成交互认证。 */
export async function loginAuthInteractive(
  remoteUrl: string,
  operationContext?: OperationContext
): Promise<LoreOperationResult> {
  return runOperation('lore_auth_login_interactive', { remoteUrl }, operationContext)
}

/**
 * 一次性提交 Token。
 *
 * 调用方必须在 Promise 建立后立即清空输入；服务不缓存、记录或返回 Token。
 */
export async function loginAuthWithToken(
  remoteUrl: string,
  token: string,
  tokenType: string,
  authUrl?: string,
  operationContext?: OperationContext
): Promise<LoreOperationResult> {
  return runOperation(
    'lore_auth_login_with_token',
    {
      remoteUrl,
      token,
      tokenType,
      authUrl: authUrl?.trim() || null
    },
    operationContext
  )
}

export async function logoutAuthIdentity(
  authUrl: string,
  userId: string,
  operationContext?: OperationContext
): Promise<LoreOperationResult> {
  return runOperation('lore_auth_logout', { authUrl, userId }, operationContext)
}

export async function clearAuthIdentities(operationContext?: OperationContext): Promise<LoreOperationResult> {
  return runOperation('lore_auth_clear', {}, operationContext)
}

/**
 * 认证账户变化后释放所有已打开仓库的原生上下文。
 *
 * 这里只传递仓库路径，不传递 Token 或账户资料；Rust 会重新校验路径，并让下一次
 * Status 读取按最新 Token Store 与仓库账户绑定重新建立远端连接。
 */
export async function refreshRepositoryAuthenticationContexts(
  repositoryPaths: string[],
  operationContext?: OperationContext
): Promise<void> {
  const normalizedPaths = [...new Set(repositoryPaths.filter((path) => path.trim().length > 0))]
  if (normalizedPaths.length === 0) return
  await invokeLogged(
    'lore_auth_repository_contexts_refresh',
    {
      repositoryPaths: normalizedPaths
    },
    operationContext
  )
}

/** 立即切换仓库认证身份；偏好持久化由调用方在命令成功后单独完成。 */
export async function setRepositoryAuthAccountBinding(
  repositoryPath: string,
  userId?: string,
  authUrl?: string,
  operationContext?: OperationContext
): Promise<void> {
  await invokeLogged(
    'lore_auth_repository_binding_set',
    {
      repositoryPath,
      userId: userId?.trim() || null,
      authUrl: authUrl?.trim() || null
    },
    operationContext
  )
}

/** Auth 服务之间的 userId 不保证全局唯一，显示名缓存必须同时包含认证端点。 */
function authIdentityKey(authUrl: string, userId: string): string {
  return `${authUrl}\u0000${userId}`
}

export function parseAuthIdentities(events: LoreEvent[]): LoreAuthIdentity[] {
  return events
    .filter((event) => event.tagName === 'authIdentity')
    .map((event) => {
      const userId = readString(event.data.userId)
      const expires = readNumber(event.data.expires)
      return {
        authUrl: readString(event.data.authUrl),
        resource: readString(event.data.resource),
        userId,
        authorizedDomains: readString(event.data.authorizedDomains)
          .split(',')
          .map((domain) => domain.trim())
          .filter(Boolean),
        expiresAt: expires > 0 ? expires : undefined,
        displayName: undefined
      }
    })
    .filter((identity) => identity.authUrl.length > 0 && identity.userId.length > 0)
}
