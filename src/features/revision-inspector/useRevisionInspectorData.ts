import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { loadRevisionChanges, loadRevisionDiff, loadRevisionFiles } from '../../services/lore'
import { readErrorMessage } from '../../shared/lib'
import { changeFilePath, createDemoWorkingTreeDiff } from '../../shared/lib'
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
  revisionChangesDiffVisible: boolean
  demoRevisionFiles: ChangeFile[]
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
  revisionChangesDiffVisible,
  demoRevisionFiles
}: UseRevisionInspectorDataOptions) {
  const [revisionChanges, setRevisionChanges] = useState<ChangeFile[]>([])
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
  const revisionChangesRequestCounter = useRef(0)
  const revisionDiffRequestCounter = useRef(0)
  const revisionFilesRequestCounter = useRef(0)

  const selectRevisionPrimaryChange = useCallback((file: ChangeFile | null) => {
    setRevisionPrimaryChangePath(file ? changeFilePath(file) : '')
  }, [])

  useEffect(() => {
    revisionChangesRequestCounter.current += 1
    const requestId = revisionChangesRequestCounter.current
    setRevisionChangesError(null)

    if (!selectedRevision) {
      setRevisionChanges([])
      setRevisionChangesRevisionId('')
      setRevisionPrimaryChangePath('')
      setRevisionChangesLoading(false)
      return
    }
    if (applicationMode === 'browser-demo') {
      setRevisionChanges([])
      setRevisionChangesRevisionId(selectedRevision.id)
      setRevisionDiffSource(selectedRevision.parentIds[0] ?? null)
      setRevisionChangesLoading(false)
      return
    }
    if (inspectorTab !== 'changes') {
      setRevisionChangesLoading(false)
      return
    }

    setRevisionChanges([])
    setRevisionChangesRevisionId('')
    setRevisionPrimaryChangePath('')
    setRevisionChangesLoading(true)
    /*
     * 合并 Revision 的第一父可能与结果树完全相同。并行读取各父节点的轻量清单，
     * 仅当第一父为空时回退首个非空父节点，不批量传输补丁或文件内容。
     */
    void loadRevisionDiffBaseline(selectedRevision.parentIds, (sourceRevision) =>
      loadRevisionChanges(repositoryPath, sourceRevision, selectedRevision.id)
    )
      .then((baseline) => {
        if (requestId !== revisionChangesRequestCounter.current) return
        setRevisionDiffSource(baseline.sourceRevision)
        setRevisionChanges(baseline.changes)
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
    setRevisionDiffError(null)

    if (!selectedRevision || inspectorTab !== 'changes' || !revisionChangesDiffVisible || !revisionPrimaryChangePath) {
      setRevisionDiffs([])
      setRevisionDiffLoading(false)
      return
    }
    if (applicationMode === 'browser-demo') {
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
    void loadRevisionDiff(
      repositoryPath,
      revisionDiffSource,
      selectedRevision.id,
      [revisionPrimaryChangePath],
      diffPreferences
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
    demoRevisionFiles,
    diffPreferences,
    inspectorTab,
    repositoryPath,
    revisionChangesDiffVisible,
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
      setRevisionChanges([])
      setRevisionPrimaryChangePath('')
      setRevisionChangesError(null)
      setRevisionChangesLoading(true)
      void loadRevisionChanges(repositoryPath, sourceRevision, selectedRevision.id)
        .then((changes) => {
          if (requestId !== revisionChangesRequestCounter.current) return
          setRevisionChanges(changes)
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
    setRevisionFilesError(null)

    if (!revisionId || applicationMode === 'browser-demo') {
      setRevisionFiles([])
      setRevisionFilesRevisionId('')
      setRevisionFilesLoading(false)
      return
    }
    if (inspectorTab !== 'tree') {
      setRevisionFilesLoading(false)
      return
    }

    setRevisionFiles([])
    setRevisionFilesRevisionId('')
    setRevisionFilesLoading(true)
    void loadRevisionFiles(repositoryPath, revisionId)
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
