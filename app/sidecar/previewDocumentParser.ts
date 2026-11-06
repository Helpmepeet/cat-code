import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import { posix } from 'node:path'
import { MAX_DOCUMENT_CELLS, MAX_DOCUMENT_COLUMNS, MAX_DOCUMENT_INPUT_BYTES, MAX_DOCUMENT_ROWS, parsePreviewDocumentTableResult, type PreviewDocumentCell, type PreviewDocumentTable, type PreviewDocumentTableResult, type PreviewDocumentWorkerRequest } from '../shared/previewDocument.js'

/** Bounds allocation before a ZIP parser trusts entry sizes or worksheet dimensions. */
function checkWorkbookZip(bytes: Buffer): void {
  let end = -1
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index--) {
    if (bytes.readUInt32LE(index) === 0x06054b50 && index + 22 + bytes.readUInt16LE(index + 20) === bytes.length) { end = index; break }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) throw new Error('invalid')
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), offset = bytes.readUInt32LE(end + 16)
  if (bytes.readUInt16LE(end + 8) !== count) throw new Error('invalid')
  if (end >= 20 && bytes.readUInt32LE(end - 20) === 0x07064b50) throw new Error('limit')
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff || count > 2_048 || offset + size > end) throw new Error('limit')
  let cursor = offset, expanded = 0
  for (let entry = 0; entry < count; entry++) {
    if (cursor + 46 > offset + size || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('invalid')
    const compressed = bytes.readUInt32LE(cursor + 20), uncompressed = bytes.readUInt32LE(cursor + 24), local = bytes.readUInt32LE(cursor + 42)
    if (bytes.readUInt16LE(cursor + 8) & 1) throw new Error('invalid')
    expanded += uncompressed
    if (uncompressed > 32 * 1024 * 1024 || expanded > 64 * 1024 * 1024 || local + 30 > offset || compressed > bytes.length || uncompressed === 0xffffffff || local === 0xffffffff) throw new Error('limit')
    if (bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('invalid')
    const dataStart = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
    if (dataStart + compressed > offset) throw new Error('invalid')
    cursor += 46 + bytes.readUInt16LE(cursor + 28) + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32)
  }
  if (cursor !== offset + size) throw new Error('invalid')
}

/** Papa allocates a whole record before step; reject pathological records first. */
function boundedDelimitedText(text: string, delimiter: string, sourceTruncated: boolean): string {
  let quoted = false, columns = 1, recordStart = 0, lastComplete = 0, fieldStart = true
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '"') {
      if (quoted && text[index + 1] === '"') index++
      else if (quoted) quoted = false
      else if (fieldStart) quoted = true
      fieldStart = false
    } else if (!quoted && char === delimiter) {
      if (++columns > 10_000) throw new Error('limit')
      fieldStart = true
    } else if (!quoted && (char === '\n' || char === '\r')) {
      columns = 1; recordStart = index + 1; lastComplete = index + 1; fieldStart = true
    } else fieldStart = false
    if (index - recordStart > 1024 * 1024) throw new Error('limit')
  }
  return quoted && sourceTruncated ? text.slice(0, lastComplete) : text
}
function emptyTable(sourceTruncated: boolean): PreviewDocumentTable {
  return { rows: [], columnCount: 0, rowOffset: 0, columnOffset: 0, truncated: false, sourceTruncated, sheets: [], merges: [] }
}
function parseDelimited(bytes: Buffer, request: PreviewDocumentWorkerRequest): PreviewDocumentTable {
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const delimiter = request.format === 'tsv' ? '\t' : ','
  const text = boundedDelimitedText(decoded, delimiter, request.sourceTruncated === true)
  const table = emptyTable(request.sourceTruncated === true)
  if (!text.length) { if (!table.sourceTruncated) table.totalRows = 0; table.truncated = table.sourceTruncated; return table }
  let cells = 0, stopped = false
  const parseText = text.replace(/(?:\r\n|\r|\n)$/, '')
  Papa.parse<string[]>(parseText, {
    delimiter, header: false, dynamicTyping: false, skipEmptyLines: false,
    step(result, parser) {
      if (result.errors.some(error => error.type === 'Quotes')) throw new Error('invalid')
      if (table.rows.length >= MAX_DOCUMENT_ROWS || cells + Math.min(result.data.length, MAX_DOCUMENT_COLUMNS) > MAX_DOCUMENT_CELLS) { stopped = true; parser.abort(); return }
      const row = result.data.slice(0, MAX_DOCUMENT_COLUMNS).map(text => ({ text }))
      table.columnCount = Math.max(table.columnCount, row.length)
      cells += row.length; table.rows.push(row)
      if (result.data.length > MAX_DOCUMENT_COLUMNS) table.truncated = true
    },
  })
  table.truncated ||= stopped || table.sourceTruncated
  if (!stopped && !table.sourceTruncated) table.totalRows = table.rows.length
  return table
}
function formulaCellsWithoutSavedValues(workbook: XLSX.WorkBook, name: string): Map<string, string> {
  const files = (workbook as XLSX.WorkBook & { files?: Record<string, { content?: Uint8Array }> }).files ?? {}
  const bookPath = Object.keys(files).find(path => /(?:^|\/)workbook\.xml$/.test(path))
  if (!bookPath) throw new Error('invalid')
  const directory = posix.dirname(bookPath)
  const relsPath = posix.join(directory, '_rels', `${posix.basename(bookPath)}.rels`)
  const rels = Buffer.from(files[relsPath]?.content ?? []).toString('utf8')
  const metadata = workbook.Workbook?.Sheets?.[workbook.SheetNames.indexOf(name)] as { id?: string } | undefined
  const attribute = (tag: string, key: string) => new RegExp(String.raw`(?:^|\s)${key}\s*=\s*["']([^"']*)["']`).exec(tag)?.[1]
  const relation = [...rels.matchAll(/<Relationship\b([^>]+)\/?\s*>/g)].find(match => attribute(match[1]!, 'Id') === metadata?.id)
  const target = relation && attribute(relation[1]!, 'Target')
  if (!target || attribute(relation![1]!, 'TargetMode') === 'External') throw new Error('invalid')
  const path = target.startsWith('/') ? target.slice(1) : posix.join(directory, target)
  const content = files[path]?.content
  if (!content) throw new Error('invalid')
  const xml = Buffer.from(content).toString('utf8')
  const missing = new Map<string, string>()
  for (const match of xml.matchAll(/<(?:\w+:)?c\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?c>/g)) {
    if (!/<(?:\w+:)?f(?:\s|>)/.test(match[2]!)) continue
    const cached = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v\s*>/.exec(match[2]!)
    const hasValue = cached !== null || /<(?:\w+:)?v\b[^>]*\/>/.test(match[2]!)
    const savedEmptyString = attribute(match[1]!, 't') === 'str' && hasValue
    if (savedEmptyString || cached && cached[1]!.trim().length > 0) continue
    const address = attribute(match[1]!, 'r')
    if (address) {
      const formula = /<(?:\w+:)?f\b[^>]*>([\s\S]*?)<\/(?:\w+:)?f>/.exec(match[2]!)?.[1] ?? ''
      missing.set(address, formula.replace(/&(?:lt|gt|amp|quot|apos);/g, entity => ({ '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '\"', '&apos;': "'" })[entity]!))
    }
  }
  return missing
}
function parseWorkbook(bytes: Buffer, request: PreviewDocumentWorkerRequest): PreviewDocumentTable {
  checkWorkbookZip(bytes)
  // SheetJS's sheetRows caps absolute row numbers; bound the returned used range instead.
  const workbook = XLSX.read(bytes, { type: 'buffer', WTF: true, cellFormula: true, cellText: true, cellDates: false, sheetStubs: true, bookVBA: false, bookFiles: true, sheets: request.sheet })
  const table = emptyTable(false)
  table.sheets = workbook.SheetNames.filter((_, index) => !workbook.Workbook?.Sheets?.[index]?.Hidden).map(name => ({ name }))
  const name = request.sheet ?? table.sheets[0]?.name
  if (!name || !table.sheets.some(sheet => sheet.name === name)) throw new Error('invalid')
  table.sheet = name
  const sheet = workbook.Sheets[name]
  if (!sheet) throw new Error('invalid')
  const missingValues = formulaCellsWithoutSavedValues(workbook, name)
  if (!sheet['!ref']) { table.totalRows = 0; return table }
  const range = XLSX.utils.decode_range(sheet['!ref'])
  const fullRange = XLSX.utils.decode_range(sheet['!fullref'] ?? sheet['!ref'])
  table.rowOffset = range.s.r; table.columnOffset = range.s.c
  table.totalRows = fullRange.e.r - fullRange.s.r + 1
  table.columnCount = Math.min(MAX_DOCUMENT_COLUMNS, range.e.c - range.s.c + 1)
  const count = Math.min(MAX_DOCUMENT_ROWS, Math.floor(MAX_DOCUMENT_CELLS / table.columnCount), range.e.r - range.s.r + 1)
  for (let index = 0; index < count; index++) {
    const row: PreviewDocumentCell[] = []
    for (let column = 0; column < table.columnCount; column++) {
      const address = XLSX.utils.encode_cell({ r: range.s.r + index, c: range.s.c + column })
      const cell = sheet[address] as XLSX.CellObject | undefined
      const formula = cell?.f ?? missingValues.get(address)
      const noSavedValue = missingValues.has(address) || formula !== undefined && (cell?.v === undefined || cell?.v === null)
      row.push({ text: noSavedValue ? '' : cell ? cell.w ?? XLSX.utils.format_cell(cell) : '', ...(formula === undefined ? {} : { formula }), ...(noSavedValue ? { noSavedValue: true } : {}) })
    }
    table.rows.push(row)
  }
  table.truncated = table.rows.length < table.totalRows || table.columnCount < fullRange.e.c - fullRange.s.c + 1
  table.merges = (sheet['!merges'] ?? []).filter(range => range.s.r < table.rowOffset + count && range.s.c < table.columnOffset + table.columnCount).map(range => ({ startRow: range.s.r, startColumn: range.s.c, endRow: range.e.r, endColumn: range.e.c }))
  return table
}
export function parsePreviewDocument(request: PreviewDocumentWorkerRequest): PreviewDocumentTableResult {
  try {
    const bytes = Buffer.from(request.bytes, 'base64')
    if (bytes.length > MAX_DOCUMENT_INPUT_BYTES) return { ok: false, reason: 'limit' }
    const result = { ok: true as const, kind: 'table' as const, table: request.format === 'xlsx' ? parseWorkbook(bytes, request) : parseDelimited(bytes, request) }
    return parsePreviewDocumentTableResult(result) ?? { ok: false, reason: 'limit' }
  } catch (error) { return { ok: false, reason: error instanceof Error && error.message === 'limit' ? 'limit' : 'invalid' } }
}
