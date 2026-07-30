import { Binary, File, FileQuestion, Folder, LockKeyhole, TriangleAlert } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { useClientPreferences } from '../../../hooks/useClientPreferences'
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
import { BinaryDiffPreview, DiffOptionsControl, type BinaryDiffPreviewView } from '../../../shared/ui'
import type { ChangeFile, LoreFileLock, WorkingTreeDiff } from '../../../types'

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
  binaryPreviewError
}: WorkingTreeDiffProps) {
  const { t } = useTranslation()
  const { preferences } = useClientPreferences()
  const lines = useMemo(() => (diff?.patch ? parseUnifiedDiff(diff.patch) : []), [diff?.patch])
  const lineCounts = useMemo(() => countUnifiedDiffLines(lines), [lines])
  const previewableKind = file ? binaryPreviewKind(changeFilePath(file)) : null
  const contentKind = resolvedDiffContentKind(file, diff)
  const binary = contentKind === 'binary'
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
        <DiffOptionsControl />
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
          <div className="working-diff__columns" aria-hidden="true">
            <span>{t('oldLines')}</span>
            <span>{t('newLines')}</span>
            <span>{t('content')}</span>
          </div>
          <code className="working-diff__code">
            {lines.map((line) => (
              <span key={line.id} className={`working-diff__line is-${line.kind}`}>
                <i>{line.oldLine ?? ''}</i>
                <i>{line.newLine ?? ''}</i>
                <b aria-hidden="true">{line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '−' : ' '}</b>
                <span>{line.content || ' '}</span>
              </span>
            ))}
          </code>
        </div>
      )}
    </section>
  )
}
