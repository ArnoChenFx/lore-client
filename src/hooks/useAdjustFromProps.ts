import { useState } from 'react'

/**
 * 渲染期跟随（官方 "adjusting state during render" 模式）的通用封装：
 * key 变化时在渲染期执行一次 adjust，避免 effect 同步 setState
 * （react-compiler EffectSetState）。
 *
 * 约束：
 * - adjust 必须是渲染安全函数：只能调用 setState（或设置渲染期可接受的状态），
 *   不得在渲染期执行副作用（读 DOM、发起请求、写 ref）。
 * - key 应使用稳定内容签名（如 `${path}|${identity}`），不依赖父级对象引用稳定性；
 *   key 相同时不会重复调整，用户输入中的草稿不会被触碰。
 * - 内部在 adjust 之前先记录 lastKey：即使 adjust 修改了 key 的来源状态，下一次
 *   渲染以新 key 为准，比较收敛后不再调整，不会形成循环。
 * - 返回 true 表示 key 已收敛（本次渲染未触发调整）。需要“重置完成后才允许其他
 *   条件写入”的守卫场景可消费该返回值；触发调整的那次渲染返回 false，且会被
 *   React 丢弃并立即重渲染，因此组件实际看到的总是收敛后的结果。
 * - StrictMode 下同一渲染周期组件函数会调用两次：key 变化的第一次调用触发
 *   adjust，第二次调用时 lastKey 尚未更新会再次执行。由于 adjust 被约束为只含
 *   幂等的 setState，重复执行无害；不得在 adjust 中加入非 setState 副作用。
 * - 服务端渲染（renderToStaticMarkup）中 useState 初始值即当前 key，调整条件
 *   不成立，adjust 不会执行且返回 true，保持渲染纯净。
 *
 * 示例：偏好就绪后把磁盘值灌入本地草稿，值相同时保持用户输入不变。
 *
 * ```ts
 * const key = `${preferences.revisionChangesView}|${preferences.revisionChangesBrowserWidth}`
 * useAdjustFromProps(key, () => {
 *   setViewMode(preferences.revisionChangesView)
 *   setBrowserWidth(preferences.revisionChangesBrowserWidth)
 * })
 * ```
 */
export function useAdjustFromProps(key: string, adjust: () => void): boolean {
  const [lastKey, setLastKey] = useState(key)
  if (lastKey !== key) {
    setLastKey(key)
    adjust()
  }
  return lastKey === key
}
