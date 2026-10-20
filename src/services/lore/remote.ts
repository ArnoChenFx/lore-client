/** 远端服务器的仓库列表、详情与克隆。 */
import { t } from '../../i18n'
import type { OperationContext, LoreCloneOptions, LoreCloneResult, LoreEvent, RemoteRepository } from '../../types'
import { createOperationContext, withOperationRequest } from '../operationRequests'
import { LoreOperationError, invokeCommand, runOperation } from './core'
import { compareStableText, normalizeDisplayPath, readNumber, readString } from './utils'

/**
 * 通过 Lore 协议读取服务器仓库目录。
 *
 * 该调用只发送列表请求，不会创建仓库、克隆内容或修改远端状态。
 */
export async function listRemoteRepositories(
  serverUrl: string,
  userId?: string,
  operationContext?: OperationContext
): Promise<RemoteRepository[]> {
  const result = await runOperation(
    'lore_repository_list',
    { serverUrl, userId: userId?.trim() || null },
    operationContext
  )
  /*
   * 目录首屏只消费 List 事件，不能再为每个仓库等待一次 Info 请求。认证端点离线、
   * 权限不足或网络尾延迟都会让单个详情请求等到超时，而 Promise.all 会把这种延迟
   * 放大成整个认证按钮长时间忙碌。Clone 流程仍会通过 loadRemoteRepositoryInfo
   * 按需读取所选仓库的完整详情，因此这里的轻量化不会削弱后续写操作校验。
   */
  return parseRemoteRepositories(result.events)
}

/** Clone 前按需读取远端 Repository 的说明、默认 Branch 与创建身份。 */
export async function loadRemoteRepositoryInfo(
  serverUrl: string,
  repositoryName: string,
  userId?: string,
  operationContext?: OperationContext
): Promise<RemoteRepository> {
  const result = await runOperation(
    'lore_repository_info_remote',
    {
      serverUrl,
      repositoryName,
      userId: userId?.trim() || null
    },
    operationContext
  )
  const event = result.events.find((candidate) => candidate.tagName === 'repositoryData')
  if (!event) {
    throw new Error(t('remoteRepositoryInfoMissing'))
  }
  return {
    id: readString(event.data.id, 'unknown'),
    name: readString(event.data.name, repositoryName),
    remoteUrl: readString(event.data.remoteUrl),
    description: readString(event.data.description),
    defaultBranch: readString(event.data.defaultBranchName),
    defaultBranchId: readString(event.data.defaultBranch),
    creator: readString(event.data.creator),
    created: readNumber(event.data.created),
    // 固定 Lore 提交暂不发送权限与默认分支 tip；未来协议补充后可直接进入稳定 DTO。
    permissions: readString(event.data.permissions),
    targetRevision: readString(event.data.targetRevision)
  }
}

/**
 * 首屏目录返回后以固定小并发补全每个仓库的详情。
 *
 * Lore 0.x 的 List 事件没有 description；这里不能重新使用 Promise.all，否则某个
 * 无权限或不可达的 Info 请求会让整个服务器目录一直处于加载状态。调用方可在每条
 * 详情返回时立即更新 UI，并自行用代际标识丢弃已经过期的结果。
 */
export async function hydrateRemoteRepositoryDetails(
  serverUrl: string,
  repositories: RemoteRepository[],
  onRepositoryResolved: (repository: RemoteRepository, details: RemoteRepository) => void,
  userId?: string,
  shouldContinue: () => boolean = () => true,
  operationContext?: OperationContext
): Promise<void> {
  return withOperationRequest(operationContext ?? createOperationContext(null), async (requestContext) => {
    // 目录条目通常不多，三个并发请求既能快速呈现说明，也不会让认证端点被批量请求淹没。
    const workerCount = Math.min(3, repositories.length)
    let nextIndex = 0

    const runWorker = async () => {
      while (shouldContinue() && nextIndex < repositories.length) {
        const repository = repositories[nextIndex]
        nextIndex += 1
        try {
          const details = await loadRemoteRepositoryInfo(serverUrl, repository.name, userId, requestContext)
          // 当前批次已被刷新替换时，不再触发 UI 回调或派发下一条详情请求。
          if (!shouldContinue()) return
          onRepositoryResolved(repository, details)
        } catch {
          // 单仓库详情不可用时仍保留 List 返回的名称，其他条目继续正常补全。
        }
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()))
  })
}

/** 将远端仓库克隆到用户选择的位置，并返回实际创建的目录。 */
export async function cloneRepository(
  serverUrl: string,
  repositoryName: string,
  destinationParent: string,
  directoryName: string,
  viewPath?: string,
  options: LoreCloneOptions = { useSharedStore: false },
  userId?: string,
  operationContext?: OperationContext
): Promise<LoreCloneResult> {
  const cloneResult = await invokeCommand<LoreCloneResult>(
    'lore_repository_clone',
    {
      serverUrl,
      repositoryName,
      destinationParent,
      directoryName,
      viewPath: viewPath || null,
      targetRevision: options.revision?.trim() || null,
      bare: options.bare ?? false,
      directFileWrite: options.directFileWrite ?? false,
      layerRepository: options.layer?.repository.trim() || null,
      layerMetadataKey: options.layer?.metadataKey?.trim() || null,
      useSharedStore: options.useSharedStore,
      sharedStorePath: options.sharedStorePath || null,
      dependencyRootFiles: options.dependency?.rootFiles ?? [],
      dependencyTags: options.dependency?.tags ?? [],
      dependencyRecursive: options.dependency?.recursive ?? false,
      dependencyDepthLimit: options.dependency?.depthLimit ?? 0,
      userId: userId?.trim() || null
    },
    operationContext
  )
  if (cloneResult.result.status !== 0) {
    throw new LoreOperationError(cloneResult.result)
  }
  return {
    ...cloneResult,
    destinationPath: normalizeDisplayPath(cloneResult.destinationPath)
  }
}

export function parseRemoteRepositories(events: LoreEvent[]): RemoteRepository[] {
  return events
    .filter((event) => event.tagName === 'repositoryListEntry')
    .map((event) => ({
      id: readString(event.data.id, 'unknown'),
      name: readString(event.data.name, t('untitledRepository'))
    }))
    .sort((left, right) => {
      /*
       * 不依赖服务端事件顺序：先按大小写不敏感的名称排序，再用原始名称和稳定 ID
       * 破除同名及大小写相同项的平局。显式字符串比较避免系统区域设置改变顺序。
       */
      const normalizedNameOrder = compareStableText(
        left.name.toLocaleLowerCase('en-US'),
        right.name.toLocaleLowerCase('en-US')
      )
      if (normalizedNameOrder !== 0) return normalizedNameOrder
      const exactNameOrder = compareStableText(left.name, right.name)
      return exactNameOrder !== 0 ? exactNameOrder : compareStableText(left.id, right.id)
    })
}
