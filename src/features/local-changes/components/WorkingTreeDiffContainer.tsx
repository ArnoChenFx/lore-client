import { useCallback, useEffect, useRef, useState } from 'react'

import { useClientPreferences } from '../../../hooks/useClientPreferences'
import { t } from '../../../i18n'
import { loadBinaryFilePreview, loadWorkingTreeDiff } from '../../../services/lore'
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
  selectedCount
}: WorkingTreeDiffContainerProps) {
  const { preferences } = useClientPreferences()
  const [diff, setDiff] = useState<WorkingTreeDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [binaryPreview, setBinaryPreview] = useState<BinaryDiffPreviewView | null>(null)
  const [binaryPreviewLoading, setBinaryPreviewLoading] = useState(false)
  const [binaryPreviewError, setBinaryPreviewError] = useState<string | null>(null)
  const diffRequestCounter = useRef(0)
  const binaryPreviewRequestCounter = useRef(0)
  const diffQueue = useRef(new LatestTaskQueue())
  const binaryPreviewQueue = useRef(new LatestTaskQueue())

  useEffect(() => {
    const queues = [diffQueue.current, binaryPreviewQueue.current]
    queues.forEach((queue) => queue.activate())
    return () => {
      diffRequestCounter.current += 1
      binaryPreviewRequestCounter.current += 1
      queues.forEach((queue) => queue.dispose())
    }
  }, [])

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
    />
  )
}
