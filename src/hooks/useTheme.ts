import { useCallback, useEffect, useState } from 'react'

import type { ResolvedTheme, ThemePreference } from '../types'
import { useClientPreferences } from './useClientPreferences'

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference !== 'system') {
    return preference
  }
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/**
 * 管理主题偏好与实际主题。
 *
 * “跟随系统”保存的是用户意图，不把当前系统值固化到设置；系统主题在应用
 * 运行期间变化时，界面也会立即响应。
 */
export function useTheme() {
  const { preferences, update } = useClientPreferences()
  const preference = preferences.theme
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(preference))

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const applyTheme = () => {
      const resolved = resolveTheme(preference)
      setResolvedTheme(resolved)
      document.documentElement.dataset.theme = resolved
      document.documentElement.style.colorScheme = resolved
    }

    applyTheme()
    media.addEventListener('change', applyTheme)
    return () => media.removeEventListener('change', applyTheme)
  }, [preference])

  const setPreference = useCallback(
    (nextPreference: ThemePreference) => {
      update({ theme: nextPreference })
    },
    [update]
  )

  const toggleTheme = useCallback(() => {
    setPreference(resolvedTheme === 'dark' ? 'light' : 'dark')
  }, [resolvedTheme, setPreference])

  return {
    preference,
    resolvedTheme,
    setPreference,
    toggleTheme
  }
}
