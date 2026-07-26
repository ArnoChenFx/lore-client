import { useCallback, useEffect, useState } from 'react'

import {
  areClientPreferencesReady,
  getClientPreferences,
  subscribeClientPreferences,
  updateClientPreferences
} from '../services/preferences'
import type { ClientPreferences } from '../types'

/** 订阅由原生配置文件支持的全局客户端偏好。 */
export function useClientPreferences() {
  const [preferences, setPreferences] = useState(getClientPreferences)
  const [ready, setReady] = useState(areClientPreferencesReady)
  const [error, setError] = useState<string | null>(null)

  useEffect(
    () =>
      subscribeClientPreferences((nextPreferences, nextReady, nextError) => {
        setPreferences(nextPreferences)
        setReady(nextReady)
        setError(nextError)
      }),
    []
  )

  const update = useCallback((patch: Partial<ClientPreferences>) => {
    updateClientPreferences(patch)
  }, [])

  return { preferences, ready, error, update }
}
