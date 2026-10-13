/** 标签的列表、创建、更新与删除。 */
import type { LoreTag } from '../../types'
import { invokeCommand } from './core'

/** 读取 Lore 仓库共享元数据中的客户端标签。 */
export async function listTags(repositoryPath: string): Promise<LoreTag[]> {
  return invokeCommand<LoreTag[]>('lore_tag_list', { repositoryPath })
}

/** 在精确 Branch/Revision 上创建仓库共享标签。 */
export async function createTag(
  repositoryPath: string,
  name: string,
  branch: string,
  revision: string,
  message: string
): Promise<LoreTag> {
  return invokeCommand<LoreTag>('lore_tag_create', {
    repositoryPath,
    name,
    branch,
    revision,
    message
  })
}

/** 修改标签名称或说明，目标 Revision 保持不变。 */
export async function updateTag(
  repositoryPath: string,
  tagId: string,
  name: string,
  message: string
): Promise<LoreTag> {
  return invokeCommand<LoreTag>('lore_tag_update', {
    repositoryPath,
    tagId,
    name,
    message
  })
}

/** 删除稳定 ID 对应的全部标签元数据记录。 */
export async function deleteTag(repositoryPath: string, tagId: string): Promise<void> {
  await invokeCommand<void>('lore_tag_delete', { repositoryPath, tagId })
}
