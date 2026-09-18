import { useCallback, useEffect, useState } from 'react'

import { t } from '../../i18n'
import {
  createSharedStore,
  loadSharedStoreInfo,
  loadSharedStoreRegistry,
  selectSharedStoreParentDirectory,
  setSharedStoreUseAutomatically
} from '../../services/lore'
import { readErrorMessage } from '../../shared/lib'
import type { ApplicationMode, LoreSharedStoreInfo, LoreSharedStoreRegistry, OperationDetail } from '../../types'
import { operationMessage, type ActiveOperation } from '../operations'
import type { AppNotify } from './controllerTypes'

type BeginOperation = (labelKey: string, detail: string | OperationDetail) => ActiveOperation
type FinishOperation = (operation: ActiveOperation, succeeded: boolean, detail: string | OperationDetail) => void

interface UseSharedStoreControllerOptions {
  applicationMode: ApplicationMode
  settingsOpen: boolean
  beginOperation: BeginOperation
  finishOperation: FinishOperation
  notify: AppNotify
}

/**
 * 管理设备级 Shared Store 快照与写操作。
 *
 * Settings 和 Clone 共同消费同一份真实 Lore 配置，因此这里保留功能级共享状态；
 * 调用方只能通过刷新、创建和切换自动使用三个语义动作修改它。
 */
export function useSharedStoreController({
  applicationMode,
  settingsOpen,
  beginOperation,
  finishOperation,
  notify
}: UseSharedStoreControllerOptions) {
  const [info, setInfo] = useState<LoreSharedStoreInfo | null>(null)
  const [registry, setRegistry] = useState<LoreSharedStoreRegistry | null>(null)
  const [registryBusy, setRegistryBusy] = useState(false)
  const [registryError, setRegistryError] = useState<string | null>(null)
  const [listInstances, setListInstances] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    // 先跨一个微任务，使 effect 同步调用 refresh 时函数体内的状态写入脱离同步路径；
    // 用户感知与同步置位一致。
    await Promise.resolve()
    if (applicationMode !== 'tauri') {
      setInfo(null)
      setError(t('startDesktopAppManageSharedStores'))
      return
    }
    setLoading(true)
    setError(null)
    try {
      setInfo(await loadSharedStoreInfo())
    } catch (refreshError) {
      setError(readErrorMessage(refreshError))
    } finally {
      setLoading(false)
    }
  }, [applicationMode])

  useEffect(() => {
    // 弹窗打开时刷新 Store 信息，用户感知与同步刷新一致。
    if (settingsOpen) queueMicrotask(() => void refresh())
  }, [refresh, settingsOpen])

  /**
   * 按需读取 Lore 自己的 Shared Store 注册表。
   *
   * 不进入弹窗打开路径：`includeInstances` 会逐个加载每个 Store 去搜索仓库
   * 实例，成本随 Store 数量增长，因此只由用户显式触发。
   *
   * 实例开关作为依赖：复选框变更会先重渲染再传递新的回调，因而这里拿到的总是
   * 当次点击时的开关；响应回传的 `instancesRequested` 与它同源，空态文案不会再
   * 把“未查询”误报成“确无实例”。
   */
  const loadRegistry = useCallback(async () => {
    if (applicationMode !== 'tauri') {
      setRegistry(null)
      setRegistryError(t('startDesktopAppManageSharedStores'))
      return
    }
    setRegistryBusy(true)
    setRegistryError(null)
    try {
      setRegistry(await loadSharedStoreRegistry(listInstances))
    } catch (registryFailure) {
      setRegistryError(readErrorMessage(registryFailure))
    } finally {
      setRegistryBusy(false)
    }
  }, [applicationMode, listInstances])

  /** 创建成功后重读 Lore 全局配置，不在前端局部伪造 Store 列表。 */
  const create = useCallback(
    async (remoteUrl: string, parentPath: string) => {
      if (applicationMode !== 'tauri') {
        notify(t('browserDemoMode'), t('startDesktopAppManageSharedStores'), 'warning')
        return
      }
      const operation = beginOperation('createSharedStore', remoteUrl)
      setBusy(true)
      setError(null)
      try {
        await createSharedStore(remoteUrl, parentPath, true)
        await refresh()
        finishOperation(operation, true, remoteUrl)
        notify(t('sharedStoreCreated'), remoteUrl, 'success')
      } catch (createError) {
        const message = readErrorMessage(createError)
        setError(message)
        finishOperation(operation, false, message)
        notify(t('sharedStoreCreateFailed'), message, 'warning')
      } finally {
        setBusy(false)
      }
    },
    [applicationMode, beginOperation, finishOperation, notify, refresh]
  )

  /** 自动使用开关由 Lore 全局配置持久化；写入后重读真实状态。 */
  const setAutomatic = useCallback(
    async (enabled: boolean) => {
      if (applicationMode !== 'tauri') {
        notify(t('browserDemoMode'), t('startDesktopAppManageSharedStores'), 'warning')
        return
      }
      const operation = beginOperation('configureSharedStore', t('sharedStore'))
      setBusy(true)
      setError(null)
      try {
        await setSharedStoreUseAutomatically(enabled)
        await refresh()
        finishOperation(operation, true, operationMessage('status.sharedStoreAutomaticChanged', { enabled }))
      } catch (updateError) {
        const message = readErrorMessage(updateError)
        setError(message)
        finishOperation(operation, false, message)
        notify(t('sharedStoreUpdateFailed'), message, 'warning')
      } finally {
        setBusy(false)
      }
    },
    [applicationMode, beginOperation, finishOperation, notify, refresh]
  )

  return {
    info,
    loading,
    busy,
    error,
    refresh,
    create,
    setAutomatic,
    chooseParent: selectSharedStoreParentDirectory,
    registry,
    registryBusy,
    registryError,
    listInstances,
    setListInstances,
    loadRegistry
  }
}
