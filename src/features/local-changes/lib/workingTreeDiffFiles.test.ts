import { describe, expect, it, vi } from 'vitest'

import type { ChangeFile } from '../../../types'
import { WorkingTreeDiffFilesError, resolveWorkingTreeDiffFiles } from './workingTreeDiffFiles'

const baseFile: Omit<ChangeFile, 'status'> = {
  id: '1',
  path: 'Content',
  name: 'World.txt',
  staged: false,
  additions: 0,
  deletions: 0
}
const addedFile: ChangeFile = { ...baseFile, status: 'added' }
const modifiedFile: ChangeFile = { ...baseFile, status: 'modified' }
const deletedFile: ChangeFile = { ...baseFile, status: 'deleted' }

/** 真实 Lore 工作区 patch 解析出的目标：源带 @revisionNumber，rename 前缀已清洗。 */
const modifiedTarget = { name: 'Content/World.txt', prevName: 'Content/World.txt', type: 'rename-changed' as const }
const addedTarget = { name: 'Content/World.txt', type: 'change' as const }
const renamedTarget = { name: 'Content/World.txt', prevName: 'Content/World.txt', type: 'rename-pure' as const }

describe('resolveWorkingTreeDiffFiles', () => {
  it('expands an added file in a repository without commits (empty baseline)', async () => {
    const readRevisionText = vi.fn()
    const readWorkspaceText = vi.fn().mockResolvedValue("const mode = 'light';")
    const files = await resolveWorkingTreeDiffFiles(addedTarget, {
      applicationMode: 'tauri',
      currentRevisionId: '',
      file: addedFile,
      readRevisionText,
      readWorkspaceText
    })
    // 无提交仓库的所有文件都是新增：旧侧按空文件水合，不需要读取 revision。
    expect(readRevisionText).not.toHaveBeenCalled()
    expect(files).toEqual({
      oldFile: { name: 'Content/World.txt', contents: '' },
      newFile: { name: 'Content/World.txt', contents: "const mode = 'light';" }
    })
  })

  it('reads the old revision and workspace for a modified file with a committed baseline', async () => {
    const readRevisionText = vi.fn().mockResolvedValue("const mode = 'dark';")
    const readWorkspaceText = vi.fn().mockResolvedValue("const mode = 'light';")
    const files = await resolveWorkingTreeDiffFiles(modifiedTarget, {
      applicationMode: 'tauri',
      currentRevisionId: 'abc123',
      file: modifiedFile,
      readRevisionText,
      readWorkspaceText
    })
    expect(readRevisionText).toHaveBeenCalledWith('abc123', 'Content/World.txt')
    expect(files).toEqual({
      oldFile: { name: 'Content/World.txt', contents: "const mode = 'dark';" },
      newFile: { name: 'Content/World.txt', contents: "const mode = 'light';" }
    })
  })

  it('rejects reading the old revision when a modified file has no committed baseline', async () => {
    const error = await resolveWorkingTreeDiffFiles(modifiedTarget, {
      applicationMode: 'tauri',
      currentRevisionId: '',
      file: modifiedFile,
      readRevisionText: vi.fn(),
      readWorkspaceText: vi.fn()
    })
      .then(() => null)
      .catch((reason: unknown) => reason)

    // 全局 i18n 单例会被其他测试切换语言；领域错误码必须稳定，测试不再绑定英文文案。
    expect(error).toBeInstanceOf(WorkingTreeDiffFilesError)
    expect(error).toMatchObject({ code: 'missing-baseline-revision' })
  })

  it('hydrates a deleted file with an empty new side', async () => {
    const readRevisionText = vi.fn().mockResolvedValue("const mode = 'dark';")
    const readWorkspaceText = vi.fn()
    const files = await resolveWorkingTreeDiffFiles(modifiedTarget, {
      applicationMode: 'tauri',
      currentRevisionId: 'abc123',
      file: deletedFile,
      readRevisionText,
      readWorkspaceText
    })
    // 删除文件的新侧不存在，不读取工作区。
    expect(readWorkspaceText).not.toHaveBeenCalled()
    expect(files).toEqual({
      oldFile: { name: 'Content/World.txt', contents: "const mode = 'dark';" },
      newFile: { name: 'Content/World.txt', contents: '' }
    })
  })

  it('returns a null old side for a pure rename', async () => {
    const files = await resolveWorkingTreeDiffFiles(renamedTarget, {
      applicationMode: 'tauri',
      currentRevisionId: 'abc123',
      file: { ...modifiedFile, status: 'renamed' },
      readRevisionText: vi.fn(),
      readWorkspaceText: vi.fn().mockResolvedValue('new content')
    })
    expect(files).toEqual({
      oldFile: null,
      newFile: { name: 'Content/World.txt', contents: 'new content' }
    })
  })

  it('keeps the partial view in browser demo mode instead of fabricating content', async () => {
    await expect(
      resolveWorkingTreeDiffFiles(addedTarget, {
        applicationMode: 'browser-demo',
        file: addedFile,
        readRevisionText: vi.fn(),
        readWorkspaceText: vi.fn()
      })
    ).rejects.toThrow()
  })
})
