/** 仓库元数据条目的读取与解析。 */
import { t } from '../../i18n'
import type { LoreEvent, LoreMetadataEntry, LoreMetadataScope } from '../../types'
import { runOperation } from './core'
import { isRecord, readString } from './utils'

/** 读取四类 Lore 元数据，并隐藏二进制原始载荷。 */
export async function loadMetadata(
  repositoryPath: string,
  scope: LoreMetadataScope,
  target?: string,
  revision?: string
): Promise<LoreMetadataEntry[]> {
  const result = await runOperation('lore_metadata_list', {
    repositoryPath,
    scope,
    target: target?.trim() || null,
    revision: revision?.trim() || null
  })
  return parseMetadataEntries(result.events)
}

/** 供事件适配测试复用的纯元数据投影。 */
export function parseMetadataEntries(events: LoreEvent[]): LoreMetadataEntry[] {
  return events.filter((event) => event.tagName === 'metadata').map((event) => parseMetadataEntry(event))
}

function parseMetadataEntry(event: LoreEvent): LoreMetadataEntry {
  const rawValue = isRecord(event.data.value) ? event.data.value : {}
  const rawType = readString(rawValue.tagName, 'unknown').toLowerCase()
  const allowedTypes: LoreMetadataEntry['type'][] = [
    'address',
    'boolean',
    'binary',
    'context',
    'hash',
    'numeric',
    'string'
  ]
  const type = allowedTypes.includes(rawType as LoreMetadataEntry['type'])
    ? (rawType as LoreMetadataEntry['type'])
    : 'unknown'
  const data = rawValue.data
  let value: string
  if (type === 'binary') {
    const byteCount = Array.isArray(data) ? data.length : 0
    value = t('status.binaryMetadataSummary', { count: byteCount })
  } else if (typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean') {
    value = String(data)
  } else {
    value = data == null ? '' : JSON.stringify(data)
  }
  return { key: readString(event.data.key), type, value }
}
