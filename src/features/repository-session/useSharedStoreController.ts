import { useCallback, useEffect, useRef, useState } from 'react'

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
  beginOperation,
  finishOperation,
  notify
}: UseSharedStoreControllerOptions) {
  const [info, setInfo] = useState<LoreSharedStoreInfo | null>(null)
  const [registry, setRegistry] = useState<LoreSharedStoreRegistry | null>(null)
  const [registryBusy, setRegistryBusy] = useState(false)
  const [registryError, setRegistryError] = useState<string | null>(null)
  const [listInstances, setListInstancesState] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  const infoGeneration = useRef(0)
  const registryGeneration = useRef(0)
  const mutationInFlight = useRef(false)
  const listInstancesRef = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      infoGeneration.current += 1
      registryGeneration.current += 1
    }
  }, [])

  const readInfo = useCallback(async () => {
    const generation = ++infoGeneration.current
    const isCurrent = () => mounted.current && generation === infoGeneration.current
    // 先领取提交权再跨微任务；较早调用不能在写操作开始后重新取得有效代际。
    await Promise.resolve()
    if (!isCurrent()) return
    if (applicationMode !== 'tauri') {
      setInfo(null)
      setError(t('startDesktopAppManageSharedStores'))
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const next = await loadSharedStoreInfo()
      if (isCurrent()) setInfo(next)
    } catch (refreshError) {
      if (isCurrent()) setError(readErrorMessage(refreshError))
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [applicationMode])

  /** Settings 的存储分类和 Clone 显式刷新同一设备快照，弹窗关闭不使它失效。 */
  const refresh = useCallback(async () => {
    if (!mounted.current || mutationInFlight.current) return
    await readInfo()
  }, [readInfo])

  const invalidateRegistry = useCallback(() => {
    registryGeneration.current += 1
    setRegistry(null)
    setRegistryError(null)
    setRegistryBusy(false)
  }, [])

  const setListInstances = useCallback(
    (enabled: boolean) => {
      if (!mounted.current || enabled === listInstancesRef.current) return
      listInstancesRef.current = enabled
      setListInstancesState(enabled)
      invalidateRegistry()
    },
    [invalidateRegistry]
  )

  /**
   * 按需读取 Lore 自己的 Shared Store 注册表。
   *
   * 不进入弹窗打开路径：`includeInstances` 会逐个加载每个 Store 去搜索仓库
   * 实例，成本随 Store 数量增长，因此只由用户显式触发。
   *
   * 每次点击捕获当时的实例选项；选项改变或写操作开始都会使旧请求失效，
   * 避免结果、错误和 loading 分别属于不同的查询。
   */
  const loadRegistry = useCallback(async () => {
    if (!mounted.current || mutationInFlight.current) return
    const generation = ++registryGeneration.current
    const isCurrent = () => mounted.current && generation === registryGeneration.current
    const includeInstances = listInstancesRef.current
    if (applicationMode !== 'tauri') {
      setRegistry(null)
      setRegistryError(t('startDesktopAppManageSharedStores'))
      setRegistryBusy(false)
      return
    }
    setRegistryBusy(true)
    setRegistryError(null)
    try {
      const next = await loadSharedStoreRegistry(includeInstances)
      if (isCurrent()) setRegistry(next)
    } catch (registryFailure) {
      if (isCurrent()) setRegistryError(readErrorMessage(registryFailure))
    } finally {
      if (isCurrent()) setRegistryBusy(false)
    }
  }, [applicationMode])

  /** 同步门闩覆盖 React 尚未重渲染的重复点击，写入使此前所有读取失去提交权。 */
  const beginMutation = useCallback(() => {
    if (!mounted.current || mutationInFlight.current) return false
    mutationInFlight.current = true
    infoGeneration.current += 1
    setLoading(false)
    invalidateRegistry()
    setBusy(true)
    setError(null)
    return true
  }, [invalidateRegistry])

  /** 创建成功后重读 Lore 全局配置，不在前端局部伪造 Store 列表。 */
  const create = useCallback(
    async (remoteUrl: string, parentPath: string) => {
      if (!mounted.current) return
      if (applicationMode !== 'tauri') {
        notify(t('browserDemoMode'), t('startDesktopAppManageSharedStores'), 'warning')
        return
      }
      if (!beginMutation()) return
      const operation = beginOperation('createSharedStore', remoteUrl)
      try {
        await createSharedStore(remoteUrl, parentPath, true)
        if (!mounted.current) return
        await readInfo()
        if (!mounted.current) return
        finishOperation(operation, true, remoteUrl)
        notify(t('sharedStoreCreated'), remoteUrl, 'success')
      } catch (createError) {
        if (!mounted.current) return
        const message = readErrorMessage(createError)
        setError(message)
        finishOperation(operation, false, message)
        notify(t('sharedStoreCreateFailed'), message, 'warning')
      } finally {
        mutationInFlight.current = false
        if (mounted.current) setBusy(false)
      }
    },
    [applicationMode, beginMutation, beginOperation, finishOperation, notify, readInfo]
  )

  /** 自动使用开关由 Lore 全局配置持久化；写入后重读真实状态。 */
  const setAutomatic = useCallback(
    async (enabled: boolean) => {
      if (!mounted.current) return
      if (applicationMode !== 'tauri') {
        notify(t('browserDemoMode'), t('startDesktopAppManageSharedStores'), 'warning')
        return
      }
      if (!beginMutation()) return
      const operation = beginOperation('configureSharedStore', t('sharedStore'))
      try {
        await setSharedStoreUseAutomatically(enabled)
        if (!mounted.current) return
        await readInfo()
        if (!mounted.current) return
        finishOperation(operation, true, operationMessage('status.sharedStoreAutomaticChanged', { enabled }))
      } catch (updateError) {
        if (!mounted.current) return
        const message = readErrorMessage(updateError)
        setError(message)
        finishOperation(operation, false, message)
        notify(t('sharedStoreUpdateFailed'), message, 'warning')
      } finally {
        mutationInFlight.current = false
        if (mounted.current) setBusy(false)
      }
    },
    [applicationMode, beginMutation, beginOperation, finishOperation, notify, readInfo]
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
