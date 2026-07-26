/** CSV 表格预览的行/列上限，避免巨型表格卡死 Diff 面板。 */
export const CSV_PREVIEW_MAX_ROWS = 200
export const CSV_PREVIEW_MAX_COLS = 40

export interface CsvPreviewTable {
  rows: string[][]
  truncatedRows: boolean
  truncatedCols: boolean
  displayedRows: number
  displayedCols: number
}

/**
 * 解析用于内嵌预览的 CSV 文本。
 *
 * 支持引号字段、字段内换行与 `""` 转义；不执行公式，也不把内容当 HTML 插入。
 */
export function parseCsvPreview(
  text: string,
  maxRows = CSV_PREVIEW_MAX_ROWS,
  maxCols = CSV_PREVIEW_MAX_COLS
): CsvPreviewTable {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let truncatedRows = false
  let truncatedCols = false
  let index = 0
  let displayedCols = 0

  const pushField = () => {
    if (row.length < maxCols) {
      row.push(field)
    } else if (field.length > 0 || row.length >= maxCols) {
      truncatedCols = true
    }
    field = ''
  }

  const pushRow = () => {
    pushField()
    // 忽略文件末尾多余空行，避免把最终换行当成额外空记录。
    if (row.length === 1 && row[0] === '' && rows.length > 0) {
      row = []
      return
    }
    if (rows.length < maxRows) {
      displayedCols = Math.max(displayedCols, row.length)
      rows.push(row)
    } else {
      truncatedRows = true
    }
    row = []
  }

  while (index < text.length) {
    // 已截断行后仍继续扫描，只为发现是否还有更多行；字段内容不再保留。
    const char = text[index] ?? ''
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          if (!truncatedRows) field += '"'
          index += 2
          continue
        }
        inQuotes = false
        index += 1
        continue
      }
      if (!truncatedRows) field += char
      index += 1
      continue
    }

    if (char === '"') {
      inQuotes = true
      index += 1
      continue
    }
    if (char === ',') {
      if (!truncatedRows) pushField()
      else field = ''
      index += 1
      continue
    }
    if (char === '\r') {
      if (text[index + 1] === '\n') index += 1
      pushRow()
      index += 1
      continue
    }
    if (char === '\n') {
      pushRow()
      index += 1
      continue
    }
    if (!truncatedRows) field += char
    index += 1
  }

  if (!truncatedRows && (field.length > 0 || row.length > 0 || inQuotes)) {
    pushRow()
  } else if (truncatedRows && (field.length > 0 || row.length > 0 || inQuotes)) {
    truncatedRows = true
  }

  return {
    rows,
    truncatedRows,
    truncatedCols,
    displayedRows: rows.length,
    displayedCols
  }
}

/** 从 Base64 预览载荷解码 UTF-8 CSV 文本。 */
export function decodeCsvPreviewText(dataBase64: string): string {
  const bytes = Uint8Array.from(atob(dataBase64.replaceAll(/\s/g, '')), (char) => char.charCodeAt(0))
  // 去掉常见 UTF-8 BOM，避免首列表头带不可见前缀。
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(start))
}
