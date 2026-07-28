import { FileWarning } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { t } from '../../i18n'
import { CSV_PREVIEW_MAX_COLS, CSV_PREVIEW_MAX_ROWS, decodeCsvPreviewText, parseCsvPreview } from '../lib'

interface CsvTablePreviewProps {
  fileName: string
  label: string
  data: Uint8Array
}

/**
 * 将受控 CSV 字节渲染为只读表格。
 *
 * 只展示有限行/列，避免巨型表格拉垮 Inspector；单元格纯文本渲染，不解释公式。
 */
export function CsvTablePreview({ fileName, label, data }: CsvTablePreviewProps) {
  const { t } = useTranslation()
  const parsed = useMemo(() => {
    try {
      const text = decodeCsvPreviewText(data)
      return { table: parseCsvPreview(text), error: null as string | null }
    } catch {
      return { table: null, error: t('csvContentValidUtf8_7481') }
    }
  }, [data, t])

  if (parsed.error || !parsed.table) {
    return (
      <div className="binary-diff-preview__pdf-status is-error" role="alert">
        <FileWarning size={24} />
        <span>{parsed.error ?? t('unableToParseCsv')}</span>
      </div>
    )
  }

  const { table } = parsed
  if (table.rows.length === 0) {
    return (
      <div className="binary-diff-preview__pdf-status" role="status">
        <span>{t('theCsvFileIsEmpty')}</span>
      </div>
    )
  }

  const columnCount = Math.max(table.displayedCols, 1)
  const header = table.rows[0] ?? []
  const body = table.rows.slice(1)

  return (
    <div className="binary-diff-preview__csv-viewer" aria-label={t('status.csvTablePreview', { fileName, label })}>
      <div className="binary-diff-preview__csv-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col" className="binary-diff-preview__csv-index">
                #
              </th>
              {Array.from({ length: columnCount }, (_, columnIndex) => (
                <th key={`h-${columnIndex}`} scope="col">
                  {header[columnIndex] || t('status.columnNumber', { number: columnIndex + 1 })}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, rowIndex) => {
              // CSV 预览行可能重复；用内容加行号构成稳定键，避免仅用下标。
              const rowKey = `${row.join('\u0001')}#${rowIndex + 2}`
              return (
                <tr key={rowKey}>
                  <th scope="row" className="binary-diff-preview__csv-index">
                    {rowIndex + 2}
                  </th>
                  {Array.from({ length: columnCount }, (_, columnIndex) => (
                    <td key={`${rowKey}:${header[columnIndex] || columnIndex}`}>{row[columnIndex] ?? ''}</td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {(table.truncatedRows || table.truncatedCols) && (
        <p className="binary-diff-preview__model-hint">
          {t('status.csvPreviewTruncated', {
            rows: Math.min(table.displayedRows, CSV_PREVIEW_MAX_ROWS),
            columns: Math.min(columnCount, CSV_PREVIEW_MAX_COLS)
          })}
        </p>
      )}
    </div>
  )
}
