import { useCallback, useEffect, useRef, useState } from 'react'

import { useClientPreferences } from '../../../hooks/useClientPreferences'
import { t } from '../../../i18n'
import { loadBinaryFilePreview, loadWorkingTreeDiff, loadWorkspaceText } from '../../../services/lore'
import {
  changeFilePath,
  createDemoWorkingTreeDiff,
  LatestTaskQueue,
  readErrorMessage,
  resolvedDiffContentKind,
  shouldLoadRepositoryTextDiff,
  shouldUseRepositoryPreview,
  settleTasksSequentially
} from '../../../shared/lib'
import { createBinaryDiffPreviewView, type BinaryDiffPreviewView } from '../../../shared/ui'
import type {
  ApplicationMode,
  BinaryDiffPreview,
  BinaryFilePreview,
  ChangeFile,
  LoreFileLock,
  WorkingTreeDiff
} from '../../../types'
import { WorkingTreeDiff as WorkingTreeDiffView } from './WorkingTreeDiff'

interface WorkingTreeDiffContainerProps {
  applicationMode: ApplicationMode
  repositoryPath: string
  currentRevisionId?: string
  file: ChangeFile | null
  fileLock?: LoreFileLock
  selectionLabel: string | null
  selectedCount: number
  /** 行内解决后的完整文本交回上层；上层负责串行写回与快照刷新。 */
  onConflictResolved?: (file: ChangeFile, resolvedContent: string) => void
}

/**
 * 本地更改 Diff 的数据容器。
 *
 * 文本 Diff、二进制预览及请求竞态都只服务右侧面板，因此由功能组件自行持有；
 * 应用层只提供当前仓库锚点和主要选择，不接触加载、错误或过期请求状态。
 */
export function WorkingTreeDiffContainer({
  applicationMode,
  repositoryPath,
  currentRevisionId,
  file,
  fileLock,
  selectionLabel,
  selectedCount,
  onConflictResolved
}: WorkingTreeDiffContainerProps) {
  const { preferences } = useClientPreferences()
  const [diff, setDiff] = useState<WorkingTreeDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [conflictContent, setConflictContent] = useState<string | undefined>(undefined)
  const [conflictContentLoading, setConflictContentLoading] = useState(false)
  const [conflictContentError, setConflictContentError] = useState<string | null>(null)
  const [binaryPreview, setBinaryPreview] = useState<BinaryDiffPreviewView | null>(null)
  const [binaryPreviewLoading, setBinaryPreviewLoading] = useState(false)
  const [binaryPreviewError, setBinaryPreviewError] = useState<string | null>(null)
  const diffRequestCounter = useRef(0)
  const binaryPreviewRequestCounter = useRef(0)
  const conflictRequestCounter = useRef(0)
  const diffQueue = useRef(new LatestTaskQueue())
  const binaryPreviewQueue = useRef(new LatestTaskQueue())
  const conflictQueue = useRef(new LatestTaskQueue())

  useEffect(() => {
    const queues = [diffQueue.current, binaryPreviewQueue.current, conflictQueue.current]
    queues.forEach((queue) => queue.activate())
    return () => {
      diffRequestCounter.current += 1
      binaryPreviewRequestCounter.current += 1
      conflictRequestCounter.current += 1
      queues.forEach((queue) => queue.dispose())
    }
  }, [])

  /** 未解决冲突文件按主选择读取真实工作区文本，供行内解决视图渲染。 */
  useEffect(() => {
    conflictRequestCounter.current += 1
    const requestId = conflictRequestCounter.current
    conflictQueue.current.cancelPending()
    setConflictContent(undefined)
    setConflictContentError(null)

    const conflict = Boolean(file?.conflict && file?.conflictUnresolved)
    if (!conflict || applicationMode === 'browser-demo') {
      setConflictContentLoading(false)
      return
    }
    const path = changeFilePath(file!)
    setConflictContentLoading(true)
    void conflictQueue.current
      .run(() => loadWorkspaceText(repositoryPath, path))
      .then((content) => {
        if (requestId !== conflictRequestCounter.current) return
        setConflictContent(content)
      })
      .catch((error) => {
        if (requestId !== conflictRequestCounter.current) return
        setConflictContentError(readErrorMessage(error))
      })
      .finally(() => {
        if (requestId === conflictRequestCounter.current) {
          setConflictContentLoading(false)
        }
      })
  }, [applicationMode, file, repositoryPath])

  /**
   * 行内解决后的完整内容交回上层串行写回。
   *
   * 写操作必须按 Repository 串行执行，因此容器不直接调用 Lore 写命令，而是把
   * 文件与解决后内容一起交给 App 层，由 runRepositoryMutation 门闩、写回并重读
   * 真实快照；失败提示也由上层统一呈现，容器不再维护第二套写回状态。
   */
  const handleConflictResolved = useCallback(
    async (content: string) => {
      if (!file) return
      onConflictResolved?.(file, content)
    },
    [file, onConflictResolved]
  )

  const loadRepositoryBinaryPreview = useCallback(
    (path: string, revision?: string, metadataOnly = false): Promise<BinaryFilePreview> =>
      loadBinaryFilePreview(repositoryPath, path, revision, metadataOnly, preferences.binaryPreviewLimitMib),
    [preferences.binaryPreviewLimitMib, repositoryPath]
  )
  const effectiveContentKind = resolvedDiffContentKind(file, diff)

  /** 主要文件变化时按需读取真实文本 Diff，并丢弃来自旧选择的响应。 */
  useEffect(() => {
    diffRequestCounter.current += 1
    const requestId = diffRequestCounter.current
    diffQueue.current.cancelPending()
    setDiff(null)
    setDiffError(null)

    if (!file) {
      setDiffLoading(false)
      return
    }
    const path = changeFilePath(file)
    if (!shouldLoadRepositoryTextDiff(file, path, preferences.binaryDiffVisible)) {
      setDiffLoading(false)
      setDiff({
        path,
        patch: '',
        action: file.status
      })
      return
    }
    if (applicationMode === 'browser-demo') {
      setDiffLoading(false)
      setDiff(createDemoWorkingTreeDiff(file))
      return
    }

    setDiffLoading(true)
    void diffQueue.current
      .run(() => loadWorkingTreeDiff(repositoryPath, [path], preferences.diff))
      .then((diffs) => {
        if (requestId !== diffRequestCounter.current) return
        setDiff(
          diffs[0] ?? {
            path,
            patch: '',
            action: file.status
          }
        )
      })
      .catch((error) => {
        if (requestId !== diffRequestCounter.current) return
        setDiffError(readErrorMessage(error))
      })
      .finally(() => {
        if (requestId === diffRequestCounter.current) {
          setDiffLoading(false)
        }
      })
  }, [applicationMode, file, preferences.binaryDiffVisible, preferences.diff, repositoryPath])

  /**
   * 预览格式只读取当前主要文件的前后版本。关闭二进制 Diff 时，真二进制与专用资产
   * 仍请求轻量大小元数据；文本 CSV/SVG 则完全退出预览路径并改读文本 Diff。
   *
   * 新增文件没有 before，删除文件没有 after；快速切换时旧请求不会覆盖新文件。
   */
  useEffect(() => {
    const queue = binaryPreviewQueue.current
    binaryPreviewRequestCounter.current += 1
    const requestId = binaryPreviewRequestCounter.current
    queue.cancelPending()
    setBinaryPreview(null)
    setBinaryPreviewError(null)

    const path = file ? changeFilePath(file) : ''
    if (!file || !shouldUseRepositoryPreview(file, path, preferences.binaryDiffVisible, effectiveContentKind)) {
      setBinaryPreviewLoading(false)
      return
    }
    if (applicationMode === 'browser-demo') {
      setBinaryPreviewLoading(false)
      setBinaryPreviewError(t('browserDemoModeReadLocal_fca5'))
      return
    }

    const requests: Array<{
      side: keyof BinaryDiffPreview
      load: () => Promise<BinaryFilePreview>
    }> = []
    if (file.status !== 'added' && currentRevisionId) {
      requests.push({
        side: 'before',
        load: () => loadRepositoryBinaryPreview(path, currentRevisionId, !preferences.binaryDiffVisible)
      })
    }
    if (file.status !== 'deleted') {
      requests.push({
        side: 'after',
        load: () => loadRepositoryBinaryPreview(path, undefined, !preferences.binaryDiffVisible)
      })
    }
    if (requests.length === 0) {
      setBinaryPreviewLoading(false)
      setBinaryPreviewError(t('repositorySnapshotFileVersionAvailable_2c73'))
      return
    }

    setBinaryPreviewLoading(true)
    void queue
      .run(() => settleTasksSequentially(requests.map((request) => request.load)))
      .then((results) => {
        if (requestId !== binaryPreviewRequestCounter.current) return
        const next: BinaryDiffPreview = {}
        const errors: string[] = []
        results.forEach((result, index) => {
          const request = requests[index]
          if (!request) return
          if (result.status === 'fulfilled') {
            next[request.side] = result.value
          } else {
            errors.push(readErrorMessage(result.reason))
          }
        })
        if (next.before || next.after) {
          setBinaryPreview(createBinaryDiffPreviewView(next))
        } else {
          setBinaryPreviewError(errors.join('；') || t('loreReturnPreviewableFileContent_451e'))
        }
      })
      .finally(() => {
        if (requestId === binaryPreviewRequestCounter.current) {
          setBinaryPreviewLoading(false)
        }
      })
    // 组件卸载或依赖变化时主动清空预览数据，加速垃圾回收。
    return () => {
      queue.cancelPending()
      setBinaryPreview(null)
      setBinaryPreviewError(null)
    }
  }, [
    applicationMode,
    currentRevisionId,
    effectiveContentKind,
    file,
    loadRepositoryBinaryPreview,
    preferences.binaryDiffVisible
  ])

  return (
    <WorkingTreeDiffView
      file={file}
      fileLock={fileLock}
      selectionLabel={selectionLabel}
      selectedCount={selectedCount}
      diff={diff}
      loading={diffLoading}
      error={diffError}
      binaryPreview={binaryPreview}
      binaryPreviewLoading={binaryPreviewLoading}
      binaryPreviewError={binaryPreviewError}
      conflictContent={conflictContent}
      conflictContentLoading={conflictContentLoading}
      conflictContentError={conflictContentError}
      onConflictResolved={handleConflictResolved}
    />
  )
}
