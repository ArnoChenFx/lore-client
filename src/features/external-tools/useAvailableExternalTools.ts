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
 * 为两组小型工具配置生成稳定内容签名。
 *
 * 偏好服务在持久化 activeRepositoryPath 时会重新归一化整个 DTO，数组引用因此变化；
 * 直接依赖引用会把每次 Repository 标签切换误判为工具配置修改。
 */
export function externalToolConfigurationKey(preferences: ExternalToolPreferences): string {
  return JSON.stringify([preferences.externalDiffTools, preferences.externalMergeTools])
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
  const toolConfigurationKey = externalToolConfigurationKey(preferences)
  /*
   * activeRepositoryPath 等无关偏好会频繁更新顶层对象；只以两组工具配置的引用生成
   * 稳定投影，避免每次 Repository 标签切换都重新调用原生可执行文件探测。
   */
  const toolPreferencesCache = useRef<{ key: string; value: ExternalToolPreferences } | null>(null)
  if (toolPreferencesCache.current?.key !== toolConfigurationKey) {
    toolPreferencesCache.current = {
      key: toolConfigurationKey,
      value: {
        externalDiffTools: preferences.externalDiffTools,
        externalMergeTools: preferences.externalMergeTools
      }
    }
  }
  // 内容未变化时复用上一份等价数组，隔离偏好归一化产生的新引用。
  const toolPreferences = toolPreferencesCache.current.value

  useEffect(() => {
    const requestId = ++requestCounter.current
    let disposed = false
    const candidates = collectExternalToolCandidates(toolPreferences)

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
  }, [toolPreferences])

  const available = useMemo(
    () => selectAvailableExternalTools(toolPreferences, availableExternalToolIds),
    [availableExternalToolIds, toolPreferences]
  )

  return {
    availableExternalToolIds,
    ...available
  }
}
