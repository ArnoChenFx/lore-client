import { Binary, File, FileQuestion, Folder, LockKeyhole, TriangleAlert } from 'lucide-react'
import { lazy, Suspense, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { useClientPreferences } from '../../../hooks/useClientPreferences'
import { resolveTheme } from '../../../hooks/useTheme'
import { fileLockOwnerLabel } from '../../../shared/lib'
import {
  binaryPreviewKind,
  changeFilePath,
  changeFilePathTransition,
  countUnifiedDiffLines,
  parseUnifiedDiff,
  resolvedDiffContentKind,
  shouldUseRepositoryPreview
} from '../../../shared/lib'
import {
  BinaryDiffPreview,
  DiffOptionsControl,
  loadConflictResolutionViewModule,
  loadTextDiffViewModule,
  type BinaryDiffPreviewView,
  type ConflictResolutionResult,
  type TextDiffFullFileLoader
} from '../../../shared/ui'
import type { ChangeFile, LoreFileLock, WorkingTreeDiff } from '../../../types'

// Diffs/Shiki 体积较大，只在右侧实际进入文本或冲突正文时加载，避免拖慢主工作区首屏。
const TextDiffView = lazy(() => loadTextDiffViewModule().then((module) => ({ default: module.TextDiffView })))
const ConflictResolutionView = lazy(() =>
  loadConflictResolutionViewModule().then((module) => ({ default: module.ConflictResolutionView }))
)

interface WorkingTreeDiffProps {
  file: ChangeFile | null
  fileLock?: LoreFileLock
  selectionLabel: string | null
  selectedCount: number
  diff: WorkingTreeDiff | null
  loading: boolean
  error: string | null
  binaryPreview: BinaryDiffPreviewView | null
  binaryPreviewLoading: boolean
  binaryPreviewError: string | null
  /** 未解决冲突文件的行内解决内容；存在时优先渲染行内冲突解决视图。 */
  conflictContent?: string
  conflictContentLoading?: boolean
  conflictContentError?: string | null
  onConflictResolved?: (result: ConflictResolutionResult) => void
  /** 展开全文时读取真实前后文件内容的加载器；未提供时保持部分视图。 */
  loadDiffFiles?: TextDiffFullFileLoader
}

/** 本地更改专用 Diff 面板，只渲染 Lore 返回的 unified patch。 */
export function WorkingTreeDiff({
  file,
  fileLock,
  selectionLabel,
  selectedCount,
  diff,
  loading,
  error,
  binaryPreview,
  binaryPreviewLoading,
  binaryPreviewError,
  conflictContent,
  conflictContentLoading = false,
  conflictContentError = null,
  onConflictResolved,
  loadDiffFiles
}: WorkingTreeDiffProps) {
  const { t } = useTranslation()
  const { preferences } = useClientPreferences()
  // 先提取 patch 再 memo：直接写 diff?.patch 时 react-compiler 推断依赖为整个 diff
  // 对象（PreserveManualMemo），与声明的 [diff?.patch] 不匹配；提取后推断收敛到
  // 局部变量，memo 可被编译器保留。
  const patch = diff?.patch
  const lines = useMemo(() => (patch ? parseUnifiedDiff(patch) : []), [patch])
  const lineCounts = useMemo(() => countUnifiedDiffLines(lines), [lines])
  const themeType = resolveTheme(preferences.theme)
  const previewableKind = file ? binaryPreviewKind(changeFilePath(file)) : null
  const contentKind = resolvedDiffContentKind(file, diff)
  const binary = contentKind === 'binary'
  // 未知或二进制冲突保持只读；确认为文本时，即使后缀是 CSV/SVG 也必须优先解决冲突。
  const showInlineConflict = Boolean(file?.conflict && file?.conflictUnresolved && contentKind === 'text')
  const previewModeActive = file
    ? shouldUseRepositoryPreview(file, changeFilePath(file), preferences.binaryDiffVisible, contentKind)
    : false
  const pathTransition = file ? changeFilePathTransition(file) : null
  const filePathLabel = file
    ? pathTransition
      ? t('status.pathTransition', {
          source: pathTransition.sourcePath,
          target: pathTransition.targetPath
        })
      : changeFilePath(file)
    : ''
  const fileStatusLabel = file ? t(pathTransition?.kind ?? file.status) : ''

  return (
    <section className={`working-diff${fileLock ? ' has-lock' : ''}`}>
      <header className="working-diff__header">
        <div>
          <span className="working-diff__mark">
            {selectionLabel ? (
              <Folder size={15} />
            ) : binary && !previewableKind ? (
              <Binary size={15} />
            ) : (
              <File size={15} />
            )}
          </span>
          <span>
            <strong>{file?.name ?? selectionLabel?.split('/').at(-1) ?? t('noFileSelected')}</strong>
            <small>
              {file
                ? `${filePathLabel} · ${fileStatusLabel}`
                : selectionLabel
                  ? `${selectionLabel} · ${t('folderSelected')}`
                  : t('selectWorkspaceFileLeft_da82')}
            </small>
          </span>
        </div>
        <span className="working-diff__summary">
          {diff?.patch && !loading && !error && !binary && (
            <span className="diff-line-counts working-diff__line-counts">
              <b>+{lineCounts.additions}</b>
              <i>−{lineCounts.deletions}</i>
            </span>
          )}
          <span className="working-diff__selection">
            {selectedCount > 1 ? t('status.selectedShowingPrimary', { count: selectedCount }) : t('workspaceDiff')}
          </span>
        </span>
        <DiffOptionsControl
          showTextLayoutOptions={Boolean(
            file && diff?.patch && !loading && !error && !previewModeActive && !showInlineConflict
          )}
        />
      </header>

      {fileLock && (
        <div className="working-diff__lock-notice">
          <LockKeyhole size={14} />
          <span>
            <strong>{t('collaborativeLockActive')}</strong>
            <small>
              {t('status.lockOwnerBranch', {
                owner: fileLockOwnerLabel(fileLock.owner),
                branch: fileLock.branch
              })}
            </small>
          </span>
          <small>{t('collaborativeLockDoesNotBlockWrites')}</small>
        </div>
      )}

      {!file ? (
        <div className="working-diff__empty">
          {selectionLabel ? <Folder size={30} /> : <FileQuestion size={30} />}
          <strong>{selectionLabel ? t('folderSelected') : t('selectFileViewDiff_ddf0')}</strong>
          <span>{selectionLabel ? t('directoriesSingleTextDiffFiles_8d43') : t('flatTreeViewsShareSame_be9c')}</span>
        </div>
      ) : loading ? null : error ? (
        <div className="working-diff__empty is-error">
          <TriangleAlert size={27} />
          <strong>{t('unableToLoadFileDiff')}</strong>
          <span>{error}</span>
        </div>
      ) : showInlineConflict ? (
        conflictContentError ? (
          <div className="working-diff__empty is-error">
            <TriangleAlert size={27} />
            <strong>{t('unableToLoadFileDiff')}</strong>
            <span>{conflictContentError}</span>
          </div>
        ) : conflictContent === undefined && conflictContentLoading ? null : conflictContent === undefined ? (
          <div className="working-diff__empty">
            <FileQuestion size={28} />
            <strong>{t('conflictContentUnavailable')}</strong>
            <span>{t('conflictContentUnavailableHint')}</span>
          </div>
        ) : (
          <div
            className="working-diff__viewport working-diff__conflict"
            aria-label={t('status.textDiffOf', { name: file.name })}
          >
            <Suspense fallback={null}>
              <ConflictResolutionView
                content={conflictContent}
                fileName={file.name}
                themeType={themeType}
                onResolved={onConflictResolved ?? (() => undefined)}
              />
            </Suspense>
          </div>
        )
      ) : previewModeActive && !preferences.binaryDiffVisible && !binaryPreview && !binaryPreviewLoading ? (
        <div className="working-diff__empty">
          <Binary size={32} />
          <strong>{t('binaryDiffHidden')}</strong>
          <span>{t('enableBinaryDiffInOptions')}</span>
        </div>
      ) : previewModeActive ? (
        <BinaryDiffPreview
          fileName={file.name}
          preview={binaryPreview}
          loading={binaryPreviewLoading}
          error={binaryPreviewError}
          size={file.size ? Number(file.size) : undefined}
        />
      ) : lines.length === 0 ? (
        <div className="working-diff__empty">
          <FileQuestion size={28} />
          <strong>{t('noTextDiffToDisplay')}</strong>
          <span>{t('loreReturnPatchFileMay_9442')}</span>
        </div>
      ) : (
        <div className="working-diff__viewport" aria-label={t('status.textDiffOf', { name: file.name })}>
          <Suspense fallback={null}>
            <TextDiffView
              patch={diff?.patch ?? ''}
              filePath={changeFilePath(file)}
              themeType={themeType}
              diffStyle={preferences.diff.diffStyle}
              expandFullFile={preferences.diff.expandFullFile}
              loadDiffFiles={loadDiffFiles}
            />
          </Suspense>
        </div>
      )}
    </section>
  )
}
