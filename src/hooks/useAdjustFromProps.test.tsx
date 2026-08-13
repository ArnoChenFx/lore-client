import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { useAdjustFromProps } from './useAdjustFromProps'

/**
 * useAdjustFromProps 的渲染期调整依赖客户端渲染机制：key 变化只在组件状态持久化
 * 的后续渲染中触发。项目测试环境（node + renderToStaticMarkup）无法模拟跨渲染的
 * 状态收敛，这里验证服务端渲染下的行为契约：稳定 key 不执行 adjust、不抛错、
 * 收敛标记为 true。
 */
function Probe({ keyValue, onChange }: { keyValue: string; onChange: () => void }) {
  const settled = useAdjustFromProps(keyValue, onChange)
  return <span data-settled={String(settled)}>{keyValue}</span>
}

describe('useAdjustFromProps server rendering', () => {
  it('does not run the adjust callback for a stable key and reports settled', () => {
    let calls = 0
    const html = renderToStaticMarkup(<Probe keyValue="a|1" onChange={() => (calls += 1)} />)

    // SSR 中 useState 初始值即当前 key，调整条件不成立：adjust 不得执行（保持
    // 渲染纯净），收敛标记为 true，且不抛错。
    expect(html).toContain('data-settled="true"')
    expect(calls).toBe(0)
  })
})
