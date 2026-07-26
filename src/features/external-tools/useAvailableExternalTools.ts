import { useEffect, useMemo, useRef, useState } from 'react'

import { detectExternalTools } from '../../services/lore'
import { isExternalToolConfigured, orderExternalTools } from '../../shared/lib'
import type { ClientPreferences, ExternalDiffToolPreference, ExternalMergeToolPreference } from '../../types'

type ExternalToolPreferences = Pick<ClientPreferences, 'externalDiffTools' | 'externalMergeTools'>

export interface AvailableExternalTools {
  availableExternalToolIds: string[]
  availableExternalDiffTools: ExternalDiffToolPreference[]
  availableExternalMergeTools: ExternalMergeToolPreference[]
}

/**
 * 只把参数模板完整的工具交给 Rust 探测。
 *
 * Diff 与 Merge 必须分别按自己的模板验证，不能通过 ID 反查所属列表；用户导入的
 * 配置可能复用 ID，反查会把 Diff 工具误按四路 Merge 模板过滤。
 */
export function collectExternalToolCandidates(preferences: ExternalToolPreferences): ExternalDiffToolPreference[] {
  return [
    ...preferences.externalDiffTools.filter((tool) => isExternalToolConfigured(tool, 'diff')),
    ...preferences.externalMergeTools.filter((tool) => isExternalToolConfigured(tool, 'merge'))
  ]
}

/** 根据 Rust 返回的真实可执行工具 ID，生成供工作区和冲突菜单消费的有序列表。 */
export function selectAvailableExternalTools(
  preferences: ExternalToolPreferences,
  availableExternalToolIds: readonly string[]
): Omit<AvailableExternalTools, 'availableExternalToolIds'> {
  const availableIds = new Set(availableExternalToolIds)
  return {
    availableExternalDiffTools: orderExternalTools(
      preferences.externalDiffTools.filter(
        (tool) => isExternalToolConfigured(tool, 'diff') && availableIds.has(tool.id)
      )
    ),
    availableExternalMergeTools: orderExternalTools(
      preferences.externalMergeTools.filter(
        (tool) => isExternalToolConfigured(tool, 'merge') && availableIds.has(tool.id)
      )
    )
  }
}

/**
 * 探测偏好中当前真实可启动的外部 Diff/Merge 工具。
 *
 * 每次偏好变化都会使旧 effect 失效，同时递增请求序号。双重保护覆盖卸载和连续编辑
 * 两种情况，较慢的旧探测结果不能覆盖较新的工具配置。
 */
export function useAvailableExternalTools(preferences: ExternalToolPreferences): AvailableExternalTools {
  const [availableExternalToolIds, setAvailableExternalToolIds] = useState<string[]>([])
  const requestCounter = useRef(0)

  useEffect(() => {
    const requestId = ++requestCounter.current
    let disposed = false
    const candidates = collectExternalToolCandidates(preferences)

    if (candidates.length === 0) {
      setAvailableExternalToolIds([])
      return () => {
        disposed = true
      }
    }

    void detectExternalTools(candidates)
      .then((available) => {
        if (!disposed && requestId === requestCounter.current) {
          setAvailableExternalToolIds(available.map((item) => item.toolId))
        }
      })
      .catch(() => {
        if (!disposed && requestId === requestCounter.current) {
          setAvailableExternalToolIds([])
        }
      })

    return () => {
      disposed = true
    }
  }, [preferences])

  const available = useMemo(
    () => selectAvailableExternalTools(preferences, availableExternalToolIds),
    [availableExternalToolIds, preferences]
  )

  return {
    availableExternalToolIds,
    ...available
  }
}
