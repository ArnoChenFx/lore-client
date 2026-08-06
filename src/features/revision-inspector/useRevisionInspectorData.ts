import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { loadRevisionChanges, loadRevisionDiff, loadRevisionFiles } from '../../services/lore'
import {
  changeFilePath,
  createDiffReadPreferences,
  createDemoWorkingTreeDiff,
  LatestTaskQueue,
  readErrorMessage,
  shouldLoadRepositoryTextDiff
} from '../../shared/lib'
import type {
  ApplicationMode,
  ChangeFile,
  ClientPreferences,
  InspectorTab,
  Revision,
  RevisionFile,
  WorkingTreeDiff
} from '../../types'
import { loadRevisionDiffBaseline } from './revisionDiffBaseline'

interface RevisionInspectorProjectionInput {
  applicationMode: ApplicationMode
  selectedRevision: Revision | null
  demoRevisionFiles: ChangeFile[]
  revisionChanges: ChangeFile[]
  revisionChangesRevisionId: string
  revisionFiles: RevisionFile[]
  revisionFilesRevisionId: string
}

export interface RevisionInspectorProjection {
  visibleInspectorFiles: ChangeFile[]
  visibleRevisionFiles: RevisionFile[]
  revisionTreeReady: boolean
  inspectorRevision: Revision | null
}

/**
 * 把异步加载结果投影到当前 Revision。
 *
 * 请求期间旧 Revision 的列表仍可能保留在 React 状态中；投影层必须用
 * `revisionChangesRevisionId` / `revisionFilesRevisionId` 阻止旧内容串入新选区。
 */
export function projectRevisionInspector({
  applicationMode,
  selectedRevision,
  demoRevisionFiles,
  revisionChanges,
  revisionChangesRevisionId,
  revisionFiles,
  revisionFilesRevisionId
}: RevisionInspectorProjectionInput): RevisionInspectorProjection {
  const visibleInspectorFiles =
    applicationMode === 'browser-demo'
      ? demoRevisionFiles
      : revisionChangesRevisionId === selectedRevision?.id
        ? revisionChanges
        : []
  const visibleRevisionFiles =
    applicationMode === 'browser-demo'
      ? demoRevisionFiles.map(
          (file): RevisionFile => ({
            id: `revision-tree-${file.id}`,
            path: file.path,
            name: file.name,
            size: file.size ?? '—',
            binary: Boolean(file.binary)
          })
        )
      : revisionFilesRevisionId === selectedRevision?.id
        ? revisionFiles
        : []
  const revisionTreeReady =
    applicationMode === 'browser-demo' || Boolean(selectedRevision && revisionFilesRevisionId === selectedRevision.id)

  if (!selectedRevision) {
    return {
      visibleInspectorFiles,
      visibleRevisionFiles,
      revisionTreeReady,
      inspectorRevision: null
    }
  }

  /*
   * 真实轻量清单只校正文件数量，不携带逐行统计。加载前保留历史摘要；加载后也不能
   * 用 DTO 中刻意为零的 additions/deletions 覆盖 Revision History 的真实摘要。
   */
  const inspectorRevision =
    applicationMode !== 'browser-demo'
      ? revisionChangesRevisionId === selectedRevision.id
        ? { ...selectedRevision, filesChanged: visibleInspectorFiles.length }
        : selectedRevision
      : {
          ...selectedRevision,
          filesChanged: visibleInspectorFiles.length,
          additions: visibleInspectorFiles.reduce((total, file) => total + file.additions, 0),
          deletions: visibleInspectorFiles.reduce((total, file) => total + file.deletions, 0)
        }

  return {
    visibleInspectorFiles,
    visibleRevisionFiles,
    revisionTreeReady,
    inspectorRevision
  }
}

interface UseRevisionInspectorDataOptions {
  applicationMode: ApplicationMode
  repositoryPath: string
  selectedRevision: Revision | null
  inspectorTab: InspectorTab
  diffPreferences: ClientPreferences['diff']
  binaryDiffVisible: boolean
  revisionChangesDiffVisible: boolean
  demoRevisionFiles: ChangeFile[]
}

/**
 * 声明每个 Inspector 标签唯一允许保留的大型资源。
 *
 * 概览只消费 Revision 摘要，不应继续持有完整变更清单或完整不可变文件树；变更与
 * 文件树也互不复用这些数组。显式策略既避免隐藏内容长期占用内存，也让测试能够锁定
 * 生命周期边界，而不是只验证旧数据没有被渲染出来。
 */
export function revisionInspectorRetention(inspectorTab: InspectorTab) {
  return {
    changes: inspectorTab === 'changes',
    files: inspectorTab === 'tree'
  }
}

interface RevisionDiffRequestContext {
  repositoryPath: string
  selectedRevisionId: string | undefined
  loadedRepositoryPath: string
  loadedRevisionId: string
  primaryPath: string
  primaryFileSupportsTextDiff: boolean
}

/**
 * 只有变更清单、主选文件和当前仓库属于同一个不可变上下文时，才允许读取完整 Diff。
 *
 * Repository Tab 切换后的第一次 render 仍会看到上一仓库的 React state；如果只在
 * effect 中清空它，就会先向新仓库发送一次“旧路径 + 旧父 Revision”的大读取。旧
 * 响应虽然不会写回 state，但 Rust/Lore 已经完成分配。显式上下文键把这类请求挡在
 * IPC 之前。
 */
export function isRevisionDiffRequestCurrent({
  repositoryPath,
  selectedRevisionId,
  loadedRepositoryPath,
  loadedRevisionId,
  primaryPath,
  primaryFileSupportsTextDiff
}: RevisionDiffRequestContext): boolean {
  return Boolean(
    repositoryPath &&
    selectedRevisionId &&
    primaryPath &&
    primaryFileSupportsTextDiff &&
    loadedRepositoryPath === repositoryPath &&
    loadedRevisionId === selectedRevisionId
  )
}

/**
 * 管理 Revision Inspector 的惰性数据与请求竞态。
 *
 * 变更清单、单文件 Diff 和完整文件树是三个独立读取面；各自使用请求序号，保证
 * 快速切换 Revision、标签或父节点时，较慢的旧响应不能覆盖当前上下文。
 */
export function useRevisionInspectorData({
  applicationMode,
  repositoryPath,
  selectedRevision,
  inspectorTab,
  diffPreferences,
  binaryDiffVisible,
  revisionChangesDiffVisible,
  demoRevisionFiles
}: UseRevisionInspectorDataOptions) {
  const [revisionChanges, setRevisionChanges] = useState<ChangeFile[]>([])
  const [revisionChangesRepositoryPath, setRevisionChangesRepositoryPath] = useState('')
  const [revisionChangesRevisionId, setRevisionChangesRevisionId] = useState('')
  const [revisionChangesLoading, setRevisionChangesLoading] = useState(false)
  const [revisionChangesError, setRevisionChangesError] = useState<string | null>(null)
  const [revisionDiffSource, setRevisionDiffSource] = useState<string | null>(null)
  const [revisionPrimaryChangePath, setRevisionPrimaryChangePath] = useState('')
  const [revisionDiffs, setRevisionDiffs] = useState<WorkingTreeDiff[]>([])
  const [revisionDiffLoading, setRevisionDiffLoading] = useState(false)
  const [revisionDiffError, setRevisionDiffError] = useState<string | null>(null)
  const [revisionFiles, setRevisionFiles] = useState<RevisionFile[]>([])
  const [revisionFilesRevisionId, setRevisionFilesRevisionId] = useState('')
  const [revisionFilesLoading, setRevisionFilesLoading] = useState(false)
  const [revisionFilesError, setRevisionFilesError] = useState<string | null>(null)
  const { contextLines, ignoreWhitespaceEol, ignoreWhitespaceInline } = diffPreferences
  const diffReadPreferences = useMemo(
    () => createDiffReadPreferences(contextLines, ignoreWhitespaceEol, ignoreWhitespaceInline),
    // 布局与展开全文只更新当前渲染，不得清空并重新读取远程 Revision patch。
    [contextLines, ignoreWhitespaceEol, ignoreWhitespaceInline]
  )
  const revisionChangesRequestCounter = useRef(0)
  const revisionDiffRequestCounter = useRef(0)
  const revisionFilesRequestCounter = useRef(0)
  const revisionChangesQueue = useRef(new LatestTaskQueue())
  const revisionDiffQueue = useRef(new LatestTaskQueue())
  const revisionFilesQueue = useRef(new LatestTaskQueue())

  useEffect(() => {
    const queues = [revisionChangesQueue.current, revisionDiffQueue.current, revisionFilesQueue.current]
    queues.forEach((queue) => queue.activate())
    return () => {
      // 先让所有仍在完成中的旧响应失效，再释放尚未开始的读取闭包。
      revisionChangesRequestCounter.current += 1
      revisionDiffRequestCounter.current += 1
      revisionFilesRequestCounter.current += 1
      queues.forEach((queue) => queue.dispose())
    }
  }, [])

  const selectRevisionPrimaryChange = useCallback((file: ChangeFile | null) => {
    setRevisionPrimaryChangePath(file ? changeFilePath(file) : '')
  }, [])

  useEffect(() => {
    revisionChangesRequestCounter.current += 1
    const requestId = revisionChangesRequestCounter.current
    revisionChangesQueue.current.cancelPending()
    setRevisionChangesError(null)

    if (!selectedRevision) {
      setRevisionChanges([])
      setRevisionChangesRepositoryPath('')
      setRevisionChangesRevisionId('')
      setRevisionPrimaryChangePath('')
      setRevisionChangesLoading(false)
      return
    }
    if (applicationMode === 'browser-demo') {
      setRevisionChanges([])
      setRevisionChangesRepositoryPath(repositoryPath)
      setRevisionChangesRevisionId(selectedRevision.id)
      setRevisionDiffSource(selectedRevision.parentIds[0] ?? null)
      setRevisionChangesLoading(false)
      return
    }
    if (!revisionInspectorRetention(inspectorTab).changes) {
      setRevisionChanges([])
      setRevisionChangesRepositoryPath('')
      setRevisionChangesRevisionId('')
      setRevisionDiffSource(null)
      setRevisionPrimaryChangePath('')
      setRevisionChangesLoading(false)
      return
    }

    setRevisionChanges([])
    setRevisionChangesRepositoryPath('')
    setRevisionChangesRevisionId('')
    setRevisionPrimaryChangePath('')
    setRevisionChangesLoading(true)
    /*
     * 合并 Revision 的第一父可能与结果树完全相同。并行读取各父节点的轻量清单，
     * 仅当第一父为空时回退首个非空父节点，不批量传输补丁或文件内容。
     */
    void revisionChangesQueue.current
      .run(() =>
        loadRevisionDiffBaseline(selectedRevision.parentIds, (sourceRevision) =>
          loadRevisionChanges(repositoryPath, sourceRevision, selectedRevision.id)
        )
      )
      .then((baseline) => {
        if (requestId !== revisionChangesRequestCounter.current) return
        setRevisionDiffSource(baseline.sourceRevision)
        setRevisionChanges(baseline.changes)
        setRevisionChangesRepositoryPath(repositoryPath)
        setRevisionChangesRevisionId(selectedRevision.id)
      })
      .catch((error) => {
        if (requestId === revisionChangesRequestCounter.current) {
          setRevisionChangesError(readErrorMessage(error))
        }
      })
      .finally(() => {
        if (requestId === revisionChangesRequestCounter.current) {
          setRevisionChangesLoading(false)
        }
      })
  }, [applicationMode, inspectorTab, repositoryPath, selectedRevision])

  useEffect(() => {
    revisionDiffRequestCounter.current += 1
    const requestId = revisionDiffRequestCounter.current
    revisionDiffQueue.current.cancelPending()
    setRevisionDiffError(null)

    const requestContextCurrent = isRevisionDiffRequestCurrent({
      repositoryPath,
      selectedRevisionId: selectedRevision?.id,
      loadedRepositoryPath: revisionChangesRepositoryPath,
      loadedRevisionId: revisionChangesRevisionId,
      primaryPath: revisionPrimaryChangePath,
      /*
       * 二进制文件与 OBJ、GLTF 等专用资产由受大小限制的 Preview IPC 读取；
       * Lore 文本 Diff 会先遍历完整 Revision 状态，既无展示价值又可能长期占用
       * 全局重读锁。CSV/SVG 只在关闭二进制 Diff 后进入文本路径；启用时分别交给
       * 受限表格预览与 Rust 安全栅格化图片预览。
       */
      primaryFileSupportsTextDiff: shouldLoadRepositoryTextDiff(
        (applicationMode === 'browser-demo' ? demoRevisionFiles : revisionChanges).find(
          (file) => changeFilePath(file) === revisionPrimaryChangePath
        ),
        revisionPrimaryChangePath,
        binaryDiffVisible
      )
    })
    if (!selectedRevision || inspectorTab !== 'changes' || !revisionChangesDiffVisible || !requestContextCurrent) {
      setRevisionDiffs([])
      setRevisionDiffLoading(false)
      return
    }
    if (applicationMode === 'browser-demo') {
      // 只为当前主要选择生成隔离夹具，保持与真实按需读取相同的数据规模。
      setRevisionDiffs(
        demoRevisionFiles
          .filter((file) => changeFilePath(file) === revisionPrimaryChangePath)
          .map(createDemoWorkingTreeDiff)
      )
      setRevisionDiffLoading(false)
      return
    }

    setRevisionDiffs([])
    setRevisionDiffLoading(true)
    void revisionDiffQueue.current
      .run(() =>
        loadRevisionDiff(
          repositoryPath,
          revisionDiffSource,
          selectedRevision.id,
          [revisionPrimaryChangePath],
          diffReadPreferences
        )
      )
      .then((diffs) => {
        if (requestId === revisionDiffRequestCounter.current) {
          setRevisionDiffs(diffs)
        }
      })
      .catch((error) => {
        if (requestId === revisionDiffRequestCounter.current) {
          setRevisionDiffError(readErrorMessage(error))
        }
      })
      .finally(() => {
        if (requestId === revisionDiffRequestCounter.current) {
          setRevisionDiffLoading(false)
        }
      })
  }, [
    applicationMode,
    binaryDiffVisible,
    demoRevisionFiles,
    diffReadPreferences,
    inspectorTab,
    repositoryPath,
    revisionChangesDiffVisible,
    revisionChanges,
    revisionChangesRepositoryPath,
    revisionChangesRevisionId,
    revisionDiffSource,
    revisionPrimaryChangePath,
    selectedRevision
  ])

  const selectRevisionDiffSource = useCallback(
    (sourceRevision: string) => {
      if (!selectedRevision || !selectedRevision.parentIds.includes(sourceRevision)) return
      setRevisionDiffSource(sourceRevision)

      if (applicationMode === 'browser-demo') return

      revisionChangesRequestCounter.current += 1
      const requestId = revisionChangesRequestCounter.current
      revisionChangesQueue.current.cancelPending()
      setRevisionChanges([])
      setRevisionChangesRepositoryPath('')
      setRevisionPrimaryChangePath('')
      setRevisionChangesError(null)
      setRevisionChangesLoading(true)
      void revisionChangesQueue.current
        .run(() => loadRevisionChanges(repositoryPath, sourceRevision, selectedRevision.id))
        .then((changes) => {
          if (requestId !== revisionChangesRequestCounter.current) return
          setRevisionChanges(changes)
          setRevisionChangesRepositoryPath(repositoryPath)
          setRevisionChangesRevisionId(selectedRevision.id)
        })
        .catch((error) => {
          if (requestId === revisionChangesRequestCounter.current) {
            setRevisionChangesError(readErrorMessage(error))
          }
        })
        .finally(() => {
          if (requestId === revisionChangesRequestCounter.current) {
            setRevisionChangesLoading(false)
          }
        })
    },
    [applicationMode, repositoryPath, selectedRevision]
  )

  useEffect(() => {
    revisionFilesRequestCounter.current += 1
    const requestId = revisionFilesRequestCounter.current
    const revisionId = selectedRevision?.id
    revisionFilesQueue.current.cancelPending()
    setRevisionFilesError(null)

    if (!revisionId || applicationMode === 'browser-demo') {
      setRevisionFiles([])
      setRevisionFilesRevisionId('')
      setRevisionFilesLoading(false)
      return
    }
    if (!revisionInspectorRetention(inspectorTab).files) {
      setRevisionFiles([])
      setRevisionFilesRevisionId('')
      setRevisionFilesLoading(false)
      return
    }

    setRevisionFiles([])
    setRevisionFilesRevisionId('')
    setRevisionFilesLoading(true)
    void revisionFilesQueue.current
      .run(() => loadRevisionFiles(repositoryPath, revisionId))
      .then((files) => {
        if (requestId === revisionFilesRequestCounter.current) {
          setRevisionFiles(files)
          setRevisionFilesRevisionId(revisionId)
        }
      })
      .catch((error) => {
        if (requestId === revisionFilesRequestCounter.current) {
          setRevisionFilesError(readErrorMessage(error))
        }
      })
      .finally(() => {
        if (requestId === revisionFilesRequestCounter.current) {
          setRevisionFilesLoading(false)
        }
      })
  }, [applicationMode, inspectorTab, repositoryPath, selectedRevision?.id])

  const projection = useMemo(
    () =>
      projectRevisionInspector({
        applicationMode,
        selectedRevision,
        demoRevisionFiles,
        revisionChanges,
        revisionChangesRevisionId,
        revisionFiles,
        revisionFilesRevisionId
      }),
    [
      applicationMode,
      demoRevisionFiles,
      revisionChanges,
      revisionChangesRevisionId,
      revisionFiles,
      revisionFilesRevisionId,
      selectedRevision
    ]
  )

  return {
    ...projection,
    revisionChangesRevisionId,
    revisionChangesLoading,
    revisionChangesError,
    revisionDiffSource,
    revisionDiffs,
    revisionDiffLoading,
    revisionDiffError,
    // 当前固定 Lore 没有额外 Diff notice；保留稳定字段供 Inspector 接口继续消费。
    revisionDiffNotice: null as string | null,
    revisionFilesLoading,
    revisionFilesError,
    selectRevisionPrimaryChange,
    selectRevisionDiffSource
  }
}
