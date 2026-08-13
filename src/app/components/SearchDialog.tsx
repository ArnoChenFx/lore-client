import { FileStack, GitBranch, GitCommitHorizontal, Search, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { t } from '../../i18n'
import type { Branch, ChangeFile, Revision } from '../../types'

type SearchResult =
  | { kind: 'revision'; id: string; title: string; detail: string; value: Revision }
  | { kind: 'branch'; id: string; title: string; detail: string; value: Branch }
  | { kind: 'change'; id: string; title: string; detail: string; value: ChangeFile }

interface SearchDialogProps {
  revisions: Revision[]
  branches: Branch[]
  changes: ChangeFile[]
  onSelect: (result: SearchResult) => void
  onClose: () => void
}

/** 在已经加载的真实仓库快照中跨 Revision、Branch 与工作区路径搜索。 */
export function SearchDialog({ revisions, branches, changes, onSelect, onClose }: SearchDialogProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const results = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return []
    const includes = (...values: Array<string | undefined>) =>
      values.some((value) => value?.toLocaleLowerCase().includes(normalized))
    return [
      ...revisions
        .filter((item) =>
          includes(item.title, item.author, item.id, ...item.branchPointers.map((pointer) => pointer.name))
        )
        .map((value): SearchResult => ({
          kind: 'revision',
          id: value.id,
          title: value.title,
          detail: `${value.shortId} · ${value.author}`,
          value
        })),
      ...branches
        .filter((item) => includes(item.name, item.author, item.latest))
        .map((value): SearchResult => ({
          kind: 'branch',
          id: value.id,
          title: value.name,
          detail: value.remote ? t('remoteBranches') : t('localBranches'),
          value
        })),
      ...changes
        .filter((item) => includes(item.name, item.path))
        .map((value): SearchResult => ({
          kind: 'change',
          id: value.id,
          title: value.name,
          detail: value.path,
          value
        }))
    ].slice(0, 80)
  }, [branches, changes, query, revisions, t])

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section className="task-dialog search-dialog" role="dialog" aria-modal="true" aria-labelledby="search-title">
        <header className="search-dialog__input composite-input">
          <Search size={17} />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('searchRevisionsBranchesOrFilePaths')}
            aria-label={t('searchRepository')}
          />
          <button type="button" aria-label={t('closeSearch')} onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="search-results">
          {!query.trim() ? (
            <div className="dialog-empty">
              <Search size={20} />
              <strong>{t('enterAKeywordToStartSearching')}</strong>
              <small>{t('searchLimitedCurrentlyLoadedRepository_c907')}</small>
            </div>
          ) : results.length === 0 ? (
            <div className="dialog-empty">
              <Search size={20} />
              <strong>{t('noMatchingResults')}</strong>
              <small>{t('tryTitleAuthorIdBranch_90ac')}</small>
            </div>
          ) : (
            results.map((result) => (
              <button
                key={`${result.kind}:${result.id}`}
                type="button"
                onClick={() => {
                  onSelect(result)
                  onClose()
                }}
              >
                <span>
                  {result.kind === 'revision' ? (
                    <GitCommitHorizontal size={15} />
                  ) : result.kind === 'branch' ? (
                    <GitBranch size={15} />
                  ) : (
                    <FileStack size={15} />
                  )}
                </span>
                <span>
                  <strong>{result.title}</strong>
                  <small>{result.detail}</small>
                </span>
                <em>
                  {result.kind === 'revision'
                    ? t('revisions')
                    : result.kind === 'branch'
                      ? t('branches')
                      : t('workspace')}
                </em>
              </button>
            ))
          )}
        </div>
      </section>
    </div>
  )
}

export type { SearchResult }
