/** Layer 与 Link 的列表、增删改与事件解析。 */
import { t } from '../../i18n'
import type {
  LoreEvent,
  LoreLayer,
  LoreLayerAddRequest,
  LoreLayerRemoveRequest,
  LoreLink,
  LoreLinkAddRequest,
  LoreLinkDetails,
  LoreLinkStagedState,
  LoreLinkUpdateRequest,
  LoreOperationResult
} from '../../types'
import { LoreCommandClientError, runOperation } from './core'
import { ZERO_HASH_PATTERN, isRecord, readNumber, readString } from './utils'

function layerResourceId(sourceRepository: string, targetPath: string): string {
  return `${sourceRepository}:${targetPath}`
}

function linkResourceId(repository: string, linkPath: string): string {
  return `${repository}:${linkPath}`
}

export function parseLayers(events: LoreEvent[], stagedEvents: LoreEvent[] = []): LoreLayer[] {
  const stagedCounts = new Map(
    stagedEvents
      .filter((event) => event.tagName === 'layerStagedEntry')
      .map((event) => {
        const sourceRepository = readString(event.data.sourceRepository, '')
        const targetPath = readString(event.data.targetPath, '/')
        return [layerResourceId(sourceRepository, targetPath), readNumber(event.data.stagedFileCount)] as const
      })
  )

  return events
    .filter((event) => event.tagName === 'layerEntry')
    .map((event, index) => {
      const targetPath = readString(event.data.targetPath ?? event.data.path, t('workspaceRoot'))
      const sourceRepository = readString(event.data.sourceRepository ?? event.data.repository, `layer-${index}`)
      const id = layerResourceId(sourceRepository, targetPath)
      return {
        id,
        targetPath,
        sourceRepository,
        sourcePath: readString(event.data.sourcePath, '/'),
        metadata: readString(event.data.metadata, '—'),
        revision: readString(event.data.revision, t('currentRevision_2')),
        stagedFileCount: stagedCounts.get(id) ?? 0
      }
    })
}

export function parseLinks(events: LoreEvent[], stagedEvents: LoreEvent[] = []): LoreLink[] {
  const stagedCounts = new Map(
    stagedEvents
      .filter((event) => event.tagName === 'linkStagedEntry')
      .map((event) => {
        const repository = readString(event.data.repository, '')
        const linkPath = readString(event.data.path, '/')
        return [linkResourceId(repository, linkPath), readNumber(event.data.stagedFileCount)] as const
      })
  )

  return events
    .filter((event) => event.tagName === 'linkEntry')
    .map((event, index) => {
      const linkPath = readString(event.data.linkPath ?? event.data.path, t('untitledPath'))
      const repository = readString(event.data.link ?? event.data.repository, `link-${index}`)
      const flags = readNumber(event.data.flags)
      const id = linkResourceId(repository, linkPath)
      return {
        id,
        linkPath,
        repository,
        sourcePath: readString(event.data.sourcePath, '/'),
        branchName: readString(event.data.branchName ?? event.data.branch, '—'),
        revision: readString(event.data.revision, '—'),
        flags,
        disableAutoFollow: (flags & 1) !== 0,
        stagedFileCount: stagedCounts.get(id) ?? 0
      }
    })
}

const LINK_STAGED_STATES = new Set<LoreLinkStagedState>(['none', 'added', 'removed', 'modified'])

/**
 * 从 `link info` 事件解析 Link 完整详情。
 *
 * `stagedState` 上游序列化为 camelCase 字符串，只有白名单内的值才会被接受；
 * remoteRevision 为零哈希（远端未查询）时置为空串，避免渲染无意义的全零 ID。
 * 事件缺失时返回 null，调用方据此提示“详情不可用”而不是伪造字段。
 */
export function parseLinkInfo(events: LoreEvent[]): LoreLinkDetails | null {
  const event = events.find((candidate) => candidate.tagName === 'linkInfo')
  if (!event || !isRecord(event.data)) return null

  const data = event.data
  const entry = isRecord(data.entry) ? data.entry : {}
  const flags = readNumber(entry.flags)
  const rawStagedState = typeof data.stagedState === 'string' ? data.stagedState : ''
  const stagedState = (LINK_STAGED_STATES as ReadonlySet<string>).has(rawStagedState)
    ? (rawStagedState as LoreLinkStagedState)
    : null
  const remoteRevision = readString(data.remoteRevision, '')
  return {
    linkPath: readString(entry.linkPath ?? entry.path, ''),
    repository: readString(entry.link ?? entry.repository, ''),
    sourcePath: readString(entry.sourcePath, '/'),
    branchName: readString(entry.branchName ?? entry.branch, ''),
    tracking: typeof entry.tracking === 'boolean' ? entry.tracking : null,
    revision: readString(entry.revision, ''),
    remoteRevision: remoteRevision && !ZERO_HASH_PATTERN.test(remoteRevision) ? remoteRevision : '',
    stagedState,
    stagedFileCount: readNumber(data.stagedFileCount),
    disableAutoFollow: (flags & 1) !== 0
  }
}

export async function listLayers(repositoryPath: string): Promise<LoreLayer[]> {
  const [result, staged] = await Promise.all([
    runOperation('lore_layer_list', { repositoryPath }),
    runOperation('lore_layer_list_staged', { repositoryPath })
  ])
  return parseLayers(result.events, staged.events)
}

export async function addLayer(repositoryPath: string, request: LoreLayerAddRequest): Promise<LoreOperationResult> {
  return runOperation('lore_layer_add', {
    repositoryPath,
    targetPath: request.targetPath,
    sourceRepository: request.sourceRepository,
    sourcePath: request.sourcePath,
    metadata: request.metadata?.trim() || null
  })
}

export async function removeLayer(
  repositoryPath: string,
  request: LoreLayerRemoveRequest
): Promise<LoreOperationResult> {
  return runOperation('lore_layer_remove', {
    repositoryPath,
    targetPath: request.targetPath,
    sourceRepository: request.sourceRepository,
    purge: request.purge
  })
}

export async function listLinks(repositoryPath: string): Promise<LoreLink[]> {
  const [result, staged] = await Promise.all([
    runOperation('lore_link_list', { repositoryPath }),
    runOperation('lore_link_list_staged', { repositoryPath })
  ])
  return parseLinks(result.events, staged.events)
}

export async function addLink(repositoryPath: string, request: LoreLinkAddRequest): Promise<LoreOperationResult> {
  return runOperation('lore_link_add', {
    repositoryPath,
    link: request.repositoryUrl,
    linkPath: request.linkPath,
    sourcePath: request.sourcePath,
    pin: request.pin?.trim() || null,
    disableBranching: request.disableBranching
  })
}

/**
 * 读取单条 Link 的完整详情。
 *
 * 仅消费 Lore 的 `linkInfo` 专用事件；事件缺失时抛出结构化错误，
 * 绝不用列表 DTO 字段伪造详情。
 */
export async function loadLinkInfo(repositoryPath: string, linkPath: string): Promise<LoreLinkDetails> {
  const result = await runOperation('lore_link_info', { repositoryPath, linkPath })
  const details = parseLinkInfo(result.events)
  if (!details) {
    throw new LoreCommandClientError({ code: 'link_info_unavailable' }, 'lore_link_info')
  }
  return details
}

export async function updateLink(repositoryPath: string, request: LoreLinkUpdateRequest): Promise<LoreOperationResult> {
  return runOperation('lore_link_update', {
    repositoryPath,
    linkPath: request.linkPath,
    pin: request.pin?.trim() || null
  })
}

export async function removeLink(repositoryPath: string, linkPath: string): Promise<LoreOperationResult> {
  return runOperation('lore_link_remove', { repositoryPath, linkPath })
}
