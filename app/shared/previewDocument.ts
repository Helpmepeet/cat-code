export const MAX_DOCUMENT_INPUT_BYTES = 16 * 1024 * 1024
export const MAX_DOCUMENT_OUTPUT_BYTES = 12 * 1024 * 1024
export const MAX_DOCUMENT_ROWS = 2_000
export const MAX_DOCUMENT_COLUMNS = 100
export const MAX_DOCUMENT_CELLS = 100_000
const MAX_CELL_TEXT = 65_536
const MAX_TABLE_TEXT = 8 * 1024 * 1024

export type FilePreviewDocumentRequest = { kind: 'pdf' } | { kind: 'table'; sheet?: string }
export interface PreviewDocumentCell { text: string; formula?: string; noSavedValue?: boolean }
export interface PreviewDocumentTable {
  rows: PreviewDocumentCell[][]
  columnCount: number
  rowOffset: number
  columnOffset: number
  totalRows?: number
  truncated: boolean
  sourceTruncated: boolean
  sheets: Array<{ name: string }>
  sheet?: string
  merges: Array<{ startRow: number; startColumn: number; endRow: number; endColumn: number }>
}
export type FilePreviewDocumentResult =
  | { ok: true; kind: 'pdf'; bytes: Uint8Array }
  | { ok: true; kind: 'table'; table: PreviewDocumentTable }
  | { ok: false; reason: 'refused' | 'invalid' | 'busy' | 'failed' | 'cancelled' | 'limit' }
export type PreviewDocumentTableResult = Exclude<FilePreviewDocumentResult, { ok: true; kind: 'pdf' }>
export interface PreviewDocumentWorkerRequest {
  format: 'csv' | 'tsv' | 'xlsx'
  bytes: string
  sheet?: string
  sourceTruncated?: boolean
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)) }
function text(value: unknown): value is string { return typeof value === 'string' && value.length <= MAX_CELL_TEXT }
function integer(value: unknown, maximum = 1_048_576): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum }
export function parseFilePreviewDocumentRequest(value: unknown): FilePreviewDocumentRequest | null {
  const row = object(value)
  if (!row || !keys(row, ['kind', 'sheet'])) return null
  if (row.kind === 'pdf' && Object.keys(row).length === 1) return { kind: 'pdf' }
  if (row.kind !== 'table' || row.sheet !== undefined && (!text(row.sheet) || row.sheet.length > 255)) return null
  return { kind: 'table', ...(row.sheet === undefined ? {} : { sheet: row.sheet }) }
}
export function parsePreviewDocumentWorkerRequest(value: unknown): PreviewDocumentWorkerRequest | null {
  const row = object(value)
  if (!row || !keys(row, ['format','bytes','sheet','sourceTruncated']) || !['csv','tsv','xlsx'].includes(row.format as string) || typeof row.bytes !== 'string' || row.bytes.length > Math.ceil(MAX_DOCUMENT_INPUT_BYTES / 3) * 4 || (row.bytes.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(row.bytes)) || row.sheet !== undefined && (!text(row.sheet) || row.sheet.length > 255) || row.sourceTruncated !== undefined && typeof row.sourceTruncated !== 'boolean') return null
  return row as unknown as PreviewDocumentWorkerRequest
}
export function parsePreviewDocumentTableResult(value: unknown): PreviewDocumentTableResult | null {
  const result = object(value)
  if (!result) return null
  if (result.ok === false && keys(result, ['ok','reason']) && ['refused','invalid','busy','failed','cancelled','limit'].includes(result.reason as string)) return result as unknown as PreviewDocumentTableResult
  if (result.ok !== true || result.kind !== 'table' || !keys(result, ['ok','kind','table'])) return null
  const table = object(result.table)
  if (!table || !keys(table, ['rows','columnCount','rowOffset','columnOffset','totalRows','truncated','sourceTruncated','sheets','sheet','merges']) || !integer(table.columnCount, MAX_DOCUMENT_COLUMNS) || !integer(table.rowOffset) || !integer(table.columnOffset, 16_384) || table.totalRows !== undefined && !integer(table.totalRows) || typeof table.truncated !== 'boolean' || typeof table.sourceTruncated !== 'boolean' || !Array.isArray(table.rows) || table.rows.length > MAX_DOCUMENT_ROWS || !Array.isArray(table.sheets) || table.sheets.length > 1_000 || table.sheet !== undefined && (!text(table.sheet) || table.sheet.length > 255) || !Array.isArray(table.merges) || table.merges.length > 10_000) return null
  if (table.rowOffset + table.rows.length > 1_048_576 || table.columnOffset + table.columnCount > 16_384) return null
  let cells = 0, characters = 0
  for (const row of table.rows) {
    if (!Array.isArray(row) || row.length > table.columnCount) return null
    for (const item of row) {
      const cell = object(item)
      if (!cell || !keys(cell,['text','formula','noSavedValue']) || !text(cell.text) || cell.formula !== undefined && !text(cell.formula) || cell.noSavedValue !== undefined && typeof cell.noSavedValue !== 'boolean') return null
      cells++; characters += cell.text.length + (typeof cell.formula === 'string' ? cell.formula.length : 0)
      if (cells > MAX_DOCUMENT_CELLS || characters > MAX_TABLE_TEXT) return null
    }
  }
  if (table.sheets.some(raw => { const sheet = object(raw); return !sheet || !keys(sheet,['name']) || typeof sheet.name !== 'string' || sheet.name.length > 255 })) return null
  if (table.sheet !== undefined && !table.sheets.some((sheet: {name: string}) => sheet.name === table.sheet)) return null
  if (table.merges.some(raw => { const merge = object(raw); return !merge || !keys(merge,['startRow','startColumn','endRow','endColumn']) || !integer(merge.startRow) || !integer(merge.endRow) || !integer(merge.startColumn,16_384) || !integer(merge.endColumn,16_384) || merge.endRow < merge.startRow || merge.endColumn < merge.startColumn })) return null
  return result as unknown as PreviewDocumentTableResult
}
