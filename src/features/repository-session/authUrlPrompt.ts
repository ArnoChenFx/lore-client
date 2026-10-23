import { useCallback, useEffect, useState } from 'react'

import type { LoreAuthUrlDismissEvent, LoreAuthUrlEvent } from '../../services/lore'
import { subscribeAuthUrl, subscribeAuthUrlDismiss } from '../../services/lore'

/** 当前需要展示给用户的交互登录确认信息。 */
export interface AuthUrlPromptState {
  operationId: string
  operation: string
  url: string
  userCode: string
}

/**
 * 新的 AuthUrl 事件直接替换当前提示。
 *
 * 同一时刻只会有一个交互登录在等待用户确认；后到的事件必然属于更新的一次
 * 登录（或同一次登录刷新了代码），保留旧提示只会让用户拿过期代码去核对。
 */
export function applyAuthUrlEvent(_current: AuthUrlPromptState | null, event: LoreAuthUrlEvent): AuthUrlPromptState {
  return {
    operationId: event.operationId,
    operation: event.operation,
    url: event.url,
    userCode: event.userCode
  }
}

/** dismiss 只收起同一次操作的提示；迟到的旧信号不能关掉新登录的提示。 */
export function applyAuthUrlDismiss(
  current: AuthUrlPromptState | null,
  event: LoreAuthUrlDismissEvent
): AuthUrlPromptState | null {
  return current?.operationId === event.operationId ? null : current
}

/** {@link useAuthUrlPrompt} 的输出契约：当前提示（无登录等待确认时为 null）与手动收起。 */
export interface AuthUrlPromptController {
  prompt: AuthUrlPromptState | null
  dismiss: () => void
}

/**
 * 全局订阅交互登录确认代码。
 *
 * 账号面板、全局重新认证等任何入口触发的浏览器登录都会经 Rust 的同一汇聚点
 * 广播，因此提示状态集中在这里，挂到应用顶层统一展示，不与某个具体入口绑定。
 * 登录结束由配对的 dismiss 信号自动收起，用户也可以手动关闭（代码仍可在登录
 * 页核对，关闭提示不影响登录本身）。
 */
export function useAuthUrlPrompt(): AuthUrlPromptController {
  const [prompt, setPrompt] = useState<AuthUrlPromptState | null>(null)

  useEffect(() => {
    let disposed = false
    const unlisteners: Array<() => void> = []
    const track = (subscription: Promise<() => void>) =>
      void subscription.then((unlisten) => {
        if (disposed) unlisten()
        else unlisteners.push(unlisten)
      })
    track(
      subscribeAuthUrl((event) => {
        if (!disposed) setPrompt((current) => applyAuthUrlEvent(current, event))
      })
    )
    track(
      subscribeAuthUrlDismiss((event) => {
        if (!disposed) setPrompt((current) => applyAuthUrlDismiss(current, event))
      })
    )
    return () => {
      disposed = true
      for (const unlisten of unlisteners) unlisten()
    }
  }, [])

  const dismiss = useCallback(() => setPrompt(null), [])
  return { prompt, dismiss }
}
