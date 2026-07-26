import { useCallback, useEffect, useRef, useState } from 'react'

import { useClientPreferences } from '../../../hooks/useClientPreferences'
import { t } from '../../../i18n'
import { loadBinaryFilePreview, loadWorkingTreeDiff } from '../../../services/lore'
import { binaryPreviewKind, changeFilePath, createDemoWorkingTreeDiff, readErrorMessage } from '../../../shared/lib'
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
  const [binaryPreview, setBinaryPreview] = useState<BinaryDiffPreview | null>(null)
  const [binaryPreviewLoading, setBinaryPreviewLoading] = useState(false)
  const [binaryPreviewError, setBinaryPreviewError] = useState<string | null>(null)
  const diffRequestCounter = useRef(0)
  const binaryPreviewRequestCounter = useRef(0)

  const loadRepositoryBinaryPreview = useCallback(
    (path: string, revision?: string): Promise<BinaryFilePreview> =>
      loadBinaryFilePreview(repositoryPath, path, revision),
    [repositoryPath]
  )

  /** 主要文件变化时按需读取真实文本 Diff，并丢弃来自旧选择的响应。 */
  useEffect(() => {
    diffRequestCounter.current += 1
    const requestId = diffRequestCounter.current
    setDiff(null)
    setDiffError(null)

    if (!file) {
      setDiffLoading(false)
      return
    }
    if (file.binary) {
      setDiffLoading(false)
      setDiff({
        path: changeFilePath(file),
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
    void loadWorkingTreeDiff(repositoryPath, [changeFilePath(file)], preferences.diff)
      .then((diffs) => {
        if (requestId !== diffRequestCounter.current) return
        setDiff(
          diffs[0] ?? {
            path: changeFilePath(file),
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
  }, [applicationMode, file, preferences.diff, repositoryPath])

  /**
   * 预览格式只读取当前主要文件的前后版本。
   *
   * 新增文件没有 before，删除文件没有 after；快速切换时旧请求不会覆盖新文件。
   */
  useEffect(() => {
    binaryPreviewRequestCounter.current += 1
    const requestId = binaryPreviewRequestCounter.current
    setBinaryPreview(null)
    setBinaryPreviewError(null)

    const path = file ? changeFilePath(file) : ''
    if (!preferences.binaryDiffVisible || !file || !binaryPreviewKind(path)) {
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
      promise: Promise<BinaryFilePreview>
    }> = []
    if (file.status !== 'added' && currentRevisionId) {
      requests.push({
        side: 'before',
        promise: loadRepositoryBinaryPreview(path, currentRevisionId)
      })
    }
    if (file.status !== 'deleted') {
      requests.push({
        side: 'after',
        promise: loadRepositoryBinaryPreview(path)
      })
    }
    if (requests.length === 0) {
      setBinaryPreviewLoading(false)
      setBinaryPreviewError(t('repositorySnapshotFileVersionAvailable_2c73'))
      return
    }

    setBinaryPreviewLoading(true)
    void Promise.allSettled(requests.map((request) => request.promise))
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
          setBinaryPreview(next)
        } else {
          setBinaryPreviewError(errors.join('；') || t('loreReturnPreviewableFileContent_451e'))
        }
      })
      .finally(() => {
        if (requestId === binaryPreviewRequestCounter.current) {
          setBinaryPreviewLoading(false)
        }
      })
  }, [applicationMode, currentRevisionId, file, loadRepositoryBinaryPreview, preferences.binaryDiffVisible])

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
