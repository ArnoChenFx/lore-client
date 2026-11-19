import { beforeEach, describe, expect, it, vi } from 'bun:test'

import type { LoreEvent } from '../types'

const invokeMock = vi.fn()
const tauriCore = await import('@tauri-apps/api/core')
vi.mock('@tauri-apps/api/core', () => ({ ...tauriCore, invoke: invokeMock, isTauri: () => true }))
const { LoreOperationError } = await import('./lore/core')
const {
  cloneRepositoryInstance,
  listRepositoryInstances,
  parseInstanceClonePlan,
  parseInstanceCloneResult,
  previewRepositoryInstanceClone
} = await import('./lore/diagnostics')
const { readInstanceId } = await import('./lore/utils')
const { ignoreWorkspacePaths } = await import('./lore/workspace')

/*
 * 夹具逐项取自 Lore v0.14.0 在真实本地共享 Store 仓库上的实例克隆事件（NTFS，不能共享数据块）；
 * 只把用户目录匿名化。`instanceId` 的真实形状是 `{ data: [16 个字节] }`，不是字符串。
 */
const SOURCE_ID_BYTES = [1, 161, 241, 215, 39, 255, 119, 123, 154, 38, 38, 108, 180, 92, 8, 180]
const CLONE_ID_BYTES = [1, 161, 241, 215, 40, 182, 113, 241, 152, 86, 18, 232, 211, 21, 216, 27]
const CLONE_ID_HEX = '01a1f1d728b671f1985612e8d315d81b'
const ZERO_ID_BYTES = Array.from({ length: 16 }, () => 0)

const COPY_REASON =
  'the source is on the NTFS volume at C:\\ and the destination on the NTFS volume at \\\\?\\C:\\, and no filesystem shares blocks between them'

const BEGIN_COPIES_BYTES: LoreEvent = {
  tagName: 'repositoryInstanceCloneBegin',
  data: {
    availableSize: 1073959890944,
    fileCount: 6,
    filesystem: 'NTFS',
    instanceId: { data: SOURCE_ID_BYTES },
    method: 'copiesBytes',
    mountPoint: 'C:/',
    reason: COPY_REASON,
    size: 32768,
    sourcePath: 'C:/Users/dev/Temp/repository',
    targetPath: 'C:/Users/dev/Temp/copies/copy-a'
  }
}

const REFUSED_COMPLETE: LoreEvent = {
  tagName: 'complete',
  data: {
    error: {
      errorCode: 9,
      message:
        'Operation not supported: cloning C:/Users/dev/Temp/repository to C:/Users/dev/Temp/copies/copy-a by sharing data blocks',
      traceLocations: []
    },
    status: 9
  }
}

const DRY_RUN_COMPLETE: LoreEvent = {
  tagName: 'repositoryInstanceCloneComplete',
  data: {
    clonedDirectoryCount: 0,
    clonedEntryCount: 0,
    copiedFileCount: 0,
    instanceId: { data: ZERO_ID_BYTES },
    targetPath: 'C:/Users/dev/Temp/copies/copy-a'
  }
}

const CLONE_COMPLETE: LoreEvent = {
  tagName: 'repositoryInstanceCloneComplete',
  data: {
    clonedDirectoryCount: 0,
    clonedEntryCount: 0,
    copiedFileCount: 6,
    instanceId: { data: CLONE_ID_BYTES },
    targetPath: 'C:/Users/dev/Temp/copies/copy-a'
  }
}

function operationResult(status: number, events: LoreEvent[]) {
  return {
    requestId: 'request',
    workspaceKey: null,
    operation: 'repository.instance-clone',
    status,
    durationMs: 1,
    events
  }
}

const request = { parentDirectory: ' C:\\Users\\dev\\Temp\\copies ', directoryName: ' copy-a ', allowCopy: false }

describe('instance id events', () => {
  it('reads the real { data: [bytes] } shape as lowercase hex and never guesses a malformed one', () => {
    expect(readInstanceId({ data: CLONE_ID_BYTES })).toBe(CLONE_ID_HEX)
    expect(readInstanceId({ data: ZERO_ID_BYTES })).toBe('0'.repeat(32))
    // 演示数据与将来可能的字符串形态原样保留。
    expect(readInstanceId('abc')).toBe('abc')
    for (const malformed of [undefined, null, 7, {}, { data: [1, 2] }, { data: [...CLONE_ID_BYTES.slice(1), 256] }]) {
      expect(readInstanceId(malformed)).toBe('')
    }
  })

  it('lists instances with distinct ids instead of empty keys', async () => {
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(
      operationResult(0, [
        {
          tagName: 'repositoryInstance',
          data: {
            branch: 'e726318bbc3fd75ac8733a7e030cc35b',
            branchName: 'main',
            instanceId: { data: CLONE_ID_BYTES },
            path: 'C:/Users/dev/Temp/copies/copy-a',
            revision: '237cd22d78a69320c0124c09698b1cd10dd3122be28c35788fb22729cf956153',
            stale: 0
          }
        },
        {
          tagName: 'repositoryInstance',
          data: {
            branch: 'e726318bbc3fd75ac8733a7e030cc35b',
            branchName: 'main',
            instanceId: { data: SOURCE_ID_BYTES },
            path: 'C:/Users/dev/Temp/repository',
            revision: '237cd22d78a69320c0124c09698b1cd10dd3122be28c35788fb22729cf956153',
            stale: 0
          }
        }
      ])
    )
    const instances = await listRepositoryInstances('C:/Users/dev/Temp/repository')
    expect(instances.map((instance) => instance.id)).toEqual([CLONE_ID_HEX, '01a1f1d727ff777b9a26266cb45c08b4'])
    expect(new Set(instances.map((instance) => instance.id)).size).toBe(2)
  })
})

describe('instance clone events', () => {
  it('reads the clone plan and falls back to unsupported for an unknown method', () => {
    expect(parseInstanceClonePlan([BEGIN_COPIES_BYTES])).toEqual({
      method: 'copiesBytes',
      sourcePath: 'C:/Users/dev/Temp/repository',
      targetPath: 'C:/Users/dev/Temp/copies/copy-a',
      filesystem: 'NTFS',
      mountPoint: 'C:/',
      size: 32768,
      fileCount: 6,
      availableSize: 1073959890944,
      reason: COPY_REASON
    })
    const future = { ...BEGIN_COPIES_BYTES, data: { ...BEGIN_COPIES_BYTES.data, method: 'someFutureMethod' } }
    // 未知方式绝不能被当成“共享数据块”。
    expect(parseInstanceClonePlan([future])?.method).toBe('unsupported')
    expect(parseInstanceClonePlan([REFUSED_COMPLETE])).toBeNull()
  })

  it('reads the clone result and refuses to invent one when the event is missing', () => {
    expect(parseInstanceCloneResult([BEGIN_COPIES_BYTES, CLONE_COMPLETE], 'fallback')).toEqual({
      targetPath: 'C:/Users/dev/Temp/copies/copy-a',
      instanceId: CLONE_ID_HEX,
      clonedDirectoryCount: 0,
      clonedEntryCount: 0,
      copiedFileCount: 6
    })
    expect(parseInstanceCloneResult([BEGIN_COPIES_BYTES], 'fallback')).toBeNull()
  })
})

describe('instance clone service', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('sends a trimmed destination as a dry run and reports the plan of an allowed preview', async () => {
    invokeMock.mockResolvedValue({
      targetPath: '\\\\?\\C:\\Users\\dev\\Temp\\copies\\copy-a',
      result: operationResult(0, [BEGIN_COPIES_BYTES, DRY_RUN_COMPLETE])
    })
    const preview = await previewRepositoryInstanceClone('C:/Users/dev/Temp/repository', {
      ...request,
      allowCopy: true
    })
    expect(invokeMock.mock.calls[0][0]).toBe('lore_repository_instance_clone')
    expect(invokeMock.mock.calls[0][1]).toMatchObject({
      repositoryPath: 'C:/Users/dev/Temp/repository',
      destinationParent: 'C:\\Users\\dev\\Temp\\copies',
      directoryName: 'copy-a',
      allowCopy: true,
      dryRun: true
    })
    // Windows 扩展路径前缀只属于系统调用，不进入界面。
    expect(preview.targetPath).toBe('C:\\Users\\dev\\Temp\\copies\\copy-a')
    expect(preview.plan.method).toBe('copiesBytes')
    expect(preview.refusal).toBeNull()
  })

  it('keeps the plan of a refused preview so the interface can explain the refusal', async () => {
    invokeMock.mockResolvedValue({
      targetPath: 'C:\\Users\\dev\\Temp\\copies\\copy-a',
      result: operationResult(9, [BEGIN_COPIES_BYTES, REFUSED_COMPLETE])
    })
    const preview = await previewRepositoryInstanceClone('C:/Users/dev/Temp/repository', request)
    expect(preview.plan.method).toBe('copiesBytes')
    expect(preview.refusal?.status).toBe(9)
    expect(preview.refusal?.message).toContain('Operation not supported')
  })

  it('throws a refusal that came before any plan, such as a local-store instance', async () => {
    invokeMock.mockResolvedValue({
      targetPath: 'C:\\Users\\dev\\Temp\\copies\\copy-a',
      result: operationResult(9, [
        {
          tagName: 'complete',
          data: {
            error: {
              errorCode: 9,
              message: 'Operation not supported: only an instance on a shared store can be cloned'
            },
            status: 9
          }
        }
      ])
    })
    await expect(previewRepositoryInstanceClone('C:/Users/dev/Temp/repository', request)).rejects.toBeInstanceOf(
      LoreOperationError
    )
  })

  it('does not report a successful preview without a plan', async () => {
    invokeMock.mockResolvedValue({ targetPath: 'C:\\copy', result: operationResult(0, []) })
    await expect(previewRepositoryInstanceClone('C:/Users/dev/Temp/repository', request)).rejects.toThrow()
  })

  it('clones for real, returns the new instance, and throws every failure', async () => {
    invokeMock.mockResolvedValue({
      targetPath: 'C:\\Users\\dev\\Temp\\copies\\copy-a',
      result: operationResult(0, [BEGIN_COPIES_BYTES, CLONE_COMPLETE])
    })
    const cloned = await cloneRepositoryInstance('C:/Users/dev/Temp/repository', { ...request, allowCopy: true })
    expect(invokeMock.mock.calls[0][1]).toMatchObject({ allowCopy: true, dryRun: false })
    expect(cloned.instanceId).toBe(CLONE_ID_HEX)
    expect(cloned.copiedFileCount).toBe(6)

    invokeMock.mockResolvedValue({
      targetPath: 'C:\\Users\\dev\\Temp\\copies\\copy-a',
      result: operationResult(118, [
        BEGIN_COPIES_BYTES,
        { tagName: 'complete', data: { error: { errorCode: 118, message: 'no room' }, status: 118 } }
      ])
    })
    await expect(cloneRepositoryInstance('C:/Users/dev/Temp/repository', request)).rejects.toBeInstanceOf(
      LoreOperationError
    )

    // 状态码 0 却没有完成事件：不能编造成功。
    invokeMock.mockResolvedValue({ targetPath: 'C:\\copy', result: operationResult(0, [BEGIN_COPIES_BYTES]) })
    await expect(cloneRepositoryInstance('C:/Users/dev/Temp/repository', request)).rejects.toThrow()
  })
})

describe('instance ignore rules at the IPC boundary', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockResolvedValue([])
  })

  it('keeps the repository .loreignore as the default scope', async () => {
    await ignoreWorkspacePaths('/tmp/project', ['asset.psd'], false)
    expect(invokeMock.mock.calls[0][0]).toBe('lore_ignore_paths')
    expect(invokeMock.mock.calls[0][1]).toMatchObject({
      repositoryPath: '/tmp/project',
      paths: ['asset.psd'],
      byExtension: false,
      instanceOnly: false
    })
  })

  it('asks for the instance ignore file only when it is requested', async () => {
    await ignoreWorkspacePaths('/tmp/project', ['asset.psd'], true, undefined, true)
    expect(invokeMock.mock.calls[0][1]).toMatchObject({ byExtension: true, instanceOnly: true })
  })
})
