import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { FilePreviewDescriptor, FilePreviewTextWindowSide } from '../../shared/filePreview.js'
import type { PreviewDocumentCell, PreviewDocumentTable } from '../../shared/previewDocument.js'
import { SourceTextView } from './SourceTextView.js'
import { FilePreviewWindowControl } from './FilePreviewWindowControl.js'
import { useSourceWrap } from './sourceWrap.js'
import { useToast } from './toastContext.js'
import './tableDocumentView.css'

const PAGE_ROWS = 50
export interface TableDocumentPosition {
  row: number
  column: number
  sheet?: string
  mode?: 'source' | 'table'
}

export function TableDocumentView({
  file, active, className = '', bodyRef, initialPosition, initialTopLine, lineTarget,
  onPosition, onTextWindow, onReady, onFailure,
}: {
  file: FilePreviewDescriptor
  active: boolean
  className?: string
  bodyRef?: RefObject<HTMLDivElement | null>
  initialPosition?: TableDocumentPosition
  initialTopLine?: number
  lineTarget?: { line: number; token: number }
  onPosition?: (position: { x?: number; y?: number; topLine?: number; table?: TableDocumentPosition }) => void
  onTextWindow?: (side: FilePreviewTextWindowSide) => void
  onReady?: () => void
  onFailure?: () => void
}) {
  const delimited = /\.(?:csv|tsv)$/i.test(file.path)
  const endWindow = delimited && file.textWindow?.side === 'end'
  const [mode, setMode] = useState<'source' | 'table'>(() => delimited && (lineTarget || endWindow) ? 'source' : initialPosition?.mode ?? 'table')
  const [loaded, setLoaded] = useState<PreviewDocumentTable | null>(null)
  const [requestedSheet, setRequestedSheet] = useState(initialPosition?.sheet)
  const [pending, setPending] = useState(false)
  const [slow, setSlow] = useState(false)
  const [tableError, setTableError] = useState(false)
  const [position, setPosition] = useState(() => ({ row: initialPosition?.row ?? 0, column: initialPosition?.column ?? 0 }))
  const [copied, setCopied] = useState(false)
  const [wrap, setWrap] = useSourceWrap()
  const root = useRef<HTMLDivElement>(null)
  const grid = useRef<HTMLDivElement>(null)
  const sourceScroller = useRef<HTMLDivElement>(null)
  const ready = useRef(onReady)
  const failed = useRef(onFailure)
  const reportPosition = useRef(onPosition)
  const loadedRef = useRef(loaded)
  const requestSequence = useRef(0)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const prefix = useId().replaceAll(':', '')
  const toast = useToast()
  ready.current = onReady
  failed.current = onFailure
  reportPosition.current = onPosition
  loadedRef.current = loaded
  const text = file.text ?? ''
  const lines = useMemo(() => text.split('\n'), [text])

  useLayoutEffect(() => {
    if (bodyRef) bodyRef.current = mode === 'source' ? sourceScroller.current ?? root.current : grid.current ?? root.current
  }, [bodyRef, mode, loaded])

  useEffect(() => {
    if (delimited && (lineTarget || endWindow)) setMode('source')
  }, [delimited, lineTarget?.token, endWindow])

  useEffect(() => {
    if (mode !== 'table' || endWindow) return
    const sequence = ++requestSequence.current
    let current = true
    setPending(true)
    setSlow(false)
    const timer = setTimeout(() => { if (current) setSlow(true) }, 300)
    void window.catcode.readFilePreviewDocument(file.id, file.revision, {
      kind: 'table', ...(requestedSheet === undefined ? {} : { sheet: requestedSheet }),
    }).then(result => {
      if (!current || sequence !== requestSequence.current) return
      if (!result.ok || result.kind !== 'table') {
        if (!loadedRef.current) failed.current?.()
        else { setTableError(true); setRequestedSheet(loadedRef.current.sheet); toast(delimited ? 'Could not open this table' : 'Could not open this sheet', { tone: 'warn' }) }
        return
      }
      const table = result.table
      setLoaded(table)
      setTableError(false)
      setPosition(previous => ({
        row: clamp(previous.row, table.rowOffset, table.rowOffset + Math.max(0, table.rows.length - 1)),
        column: clamp(previous.column, table.columnOffset, table.columnOffset + Math.max(0, table.columnCount - 1)),
      }))
    }).catch(() => {
      if (!current || sequence !== requestSequence.current) return
      if (!loadedRef.current) failed.current?.()
      else { setTableError(true); setRequestedSheet(loadedRef.current.sheet); toast(delimited ? 'Could not open this table' : 'Could not open this sheet', { tone: 'warn' }) }
    }).finally(() => {
      if (current && sequence === requestSequence.current) {
        setPending(false)
        setSlow(false)
      }
    })
    return () => { current = false; clearTimeout(timer) }
  }, [file.id, file.revision, requestedSheet, mode, endWindow, delimited, toast])

  useEffect(() => {
    if (active || mode === 'table' && !loaded) return
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => ready.current?.()) })
    return () => cancelAnimationFrame(frame)
  }, [active, loaded, mode])

  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current) }, [])

  useEffect(() => {
    if (!active) return
    reportPosition.current?.({ table: { ...position, ...(loaded?.sheet === undefined ? {} : { sheet: loaded.sheet }), mode } })
  }, [position.row, position.column, loaded?.sheet, mode, active])

  const rowIndex = loaded ? position.row - loaded.rowOffset : 0
  const columnIndex = loaded ? position.column - loaded.columnOffset : 0
  const page = Math.floor(rowIndex / PAGE_ROWS)
  const firstRow = page * PAGE_ROWS
  const shownRows = loaded?.rows.slice(firstRow, firstRow + PAGE_ROWS) ?? []
  const cell = loaded?.rows[rowIndex] ? loaded.rows[rowIndex]![columnIndex] ?? { text: '' } : undefined
  const cellId = (row: number, column: number) => `${prefix}-r${row}-c${column}`
  const hasCells = !!loaded?.rows.length && loaded.columnCount > 0
  const lastRow = loaded ? loaded.rowOffset + (loaded.totalRows ?? loaded.rows.length) : 0

  useEffect(() => {
    if (!active || mode !== 'table' || !hasCells || !grid.current?.clientHeight) return
    root.current?.querySelector<HTMLElement>(`[id="${cellId(position.row, position.column)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [position.row, position.column, page, active, mode, hasCells])

  const select = (row: number, column: number) => {
    if (!loaded || !hasCells) return
    setPosition({
      row: clamp(row, loaded.rowOffset, loaded.rowOffset + loaded.rows.length - 1),
      column: clamp(column, loaded.columnOffset, loaded.columnOffset + loaded.columnCount - 1),
    })
  }
  const copy = async () => {
    if (!cell) return
    try {
      await navigator.clipboard.writeText(cellText(cell))
      setCopied(true)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 1200)
    } catch { toast('Could not copy this cell', { tone: 'warn' }) }
  }
  const merged = loaded?.merges.find(range => position.row >= range.startRow && position.row <= range.endRow && position.column >= range.startColumn && position.column <= range.endColumn)
  return <div ref={root} tabIndex={-1} className={`table-document-view ${className}`}>
    <div className="table-document-toolbar">
      {delimited ? <div className="table-document-modes" role="group" aria-label="File view">
        <button type="button" aria-pressed={mode === 'source'} onClick={() => setMode('source')}>Source</button>
        <button type="button" aria-pressed={mode === 'table'} disabled={endWindow} title={endWindow ? 'Show the start of this file to read it as a table' : undefined} onClick={() => setMode('table')}>Table</button>
      </div> : loaded?.sheets.length ? <label className="table-document-sheet-label">
        <span className="sr-only">Sheet</span>
        <select aria-label="Sheet" value={loaded.sheet ?? loaded.sheets[0]!.name} onChange={event => setRequestedSheet(event.currentTarget.value)}>
          {loaded.sheets.map(sheet => <option key={sheet.name} value={sheet.name}>{sheet.name}</option>)}
        </select>
      </label> : null}
      {mode === 'table' && loaded && (loaded.truncated || loaded.sourceTruncated) ? <span className="table-document-partial" role="note" tabIndex={0} aria-label="Partial table"
        title={partialTableDescription(loaded)} aria-description={partialTableDescription(loaded)}>Partial</span> : null}
    </div>
    {mode === 'source' ? <>
      {file.textWindow?.invalidUtf8 ? <div className="table-document-note">Some bytes are not valid UTF-8.</div> : null}
      {lineTarget && lineTarget.line > lines.length ? <div className="table-document-note">Line {lineTarget.line} is outside what is shown.</div> : null}
      {text.length === 0 ? <div className="table-document-empty">This file is empty.</div> : <SourceTextView lines={lines} body={text} copy={text}
        gutter={index => file.textWindow?.firstLine === null ? '' : index + 1} language={null} diffRows={null} wrap={wrap} onWrap={setWrap} subject="file"
        toolbarActions={onTextWindow ? <FilePreviewWindowControl window={file.textWindow} onSelect={onTextWindow} /> : null}
        lineTarget={lineTarget} initialTopLine={initialTopLine} scrollerRef={sourceScroller} onScroll={value => { if (active) reportPosition.current?.(value) }} />}
    </> : <>
      {slow ? <div className="table-document-note" role="status">Opening {requestedSheet ?? file.path.split('/').at(-1)}</div> : null}
      {tableError ? <div className="table-document-note" role="status">Could not update this table. Showing the last version.</div> : null}
      {loaded ? <>
        <div className="table-document-formula">
          <span className="table-document-coordinate">{hasCells ? `${columnLabel(position.column)}${position.row + 1}` : ''}</span>
          <div className="table-document-value" tabIndex={hasCells ? 0 : -1} aria-label="Cell value">
            <div>{cell ? cellText(cell) : ''}</div>
            {cell?.formula === undefined ? null : <div className="table-document-formula-text">={cell.formula}</div>}
            {merged ? <div className="table-document-merge">Merged {columnLabel(merged.startColumn)}{merged.startRow + 1}:{columnLabel(merged.endColumn)}{merged.endRow + 1}</div> : null}
          </div>
          <button type="button" onClick={() => { void copy() }} disabled={!cell} aria-label={copied ? 'Cell copied' : 'Copy cell value'}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
        {hasCells ? <div ref={grid} className="table-document-grid" role="grid" tabIndex={active ? 0 : -1} aria-label="Table"
          aria-rowcount={lastRow + 1} aria-colcount={loaded.columnOffset + loaded.columnCount + 1}
          aria-activedescendant={cellId(position.row, position.column)} aria-busy={pending || undefined}
          onKeyDown={event => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c' && !event.altKey) {
              const selection = event.currentTarget.ownerDocument.defaultView?.getSelection()
              if (!selection || selection.isCollapsed || !selection.toString()) { event.preventDefault(); void copy() }
              return
            }
            if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || event.isDefaultPrevented()) return
            const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], PageUp: [-PAGE_ROWS, 0], PageDown: [PAGE_ROWS, 0] }
            const move = moves[event.key]
            if (move) { event.preventDefault(); select(position.row + move[0], position.column + move[1]) }
            else if (event.key === 'Home') { event.preventDefault(); select(position.row, loaded.columnOffset) }
            else if (event.key === 'End') { event.preventDefault(); select(position.row, loaded.columnOffset + loaded.columnCount - 1) }
          }}>
          <table className="table-document-cells" role="presentation"><thead><tr role="row" aria-rowindex={1}><th role="columnheader" aria-colindex={1} aria-label="Row" />
            {Array.from({ length: loaded.columnCount }, (_, column) => <th key={column} role="columnheader" aria-colindex={loaded.columnOffset + column + 2}>{columnLabel(loaded.columnOffset + column)}</th>)}
          </tr></thead><tbody>
            {shownRows.map((row, visibleRow) => {
              const rowNumber = loaded.rowOffset + firstRow + visibleRow
              return <tr key={rowNumber} role="row" aria-rowindex={rowNumber + 2}>
                <th role="rowheader" aria-colindex={1}>{rowNumber + 1}</th>
                {Array.from({ length: loaded.columnCount }, (_, column) => {
                  const columnNumber = loaded.columnOffset + column
                  const value = row[column]
                  return <td key={columnNumber} id={cellId(rowNumber, columnNumber)} role="gridcell" aria-colindex={columnNumber + 2}
                    aria-selected={rowNumber === position.row && columnNumber === position.column}
                    onClick={event => {
                      const selection = event.currentTarget.ownerDocument.defaultView?.getSelection()
                      if (selection && !selection.isCollapsed && selection.toString()) return
                      select(rowNumber, columnNumber)
                      grid.current?.focus({ preventScroll: true })
                    }}>{value ? cellText(value) : ''}</td>
                })}
              </tr>
            })}
          </tbody></table>
        </div> : <div className="table-document-empty">{delimited ? 'This file is empty.' : 'This sheet is empty.'}</div>}
        {loaded.rows.length > PAGE_ROWS ? <div className="table-document-pages">
          <button type="button" aria-label="Previous rows" disabled={firstRow === 0} onClick={() => select(position.row - PAGE_ROWS, position.column)}>‹</button>
          <span>{(loaded.rowOffset + firstRow + 1).toLocaleString()}–{(loaded.rowOffset + Math.min(firstRow + PAGE_ROWS, loaded.rows.length)).toLocaleString()} of {lastRow.toLocaleString()}</span>
          <button type="button" aria-label="Next rows" disabled={firstRow + PAGE_ROWS >= loaded.rows.length} onClick={() => select(position.row + PAGE_ROWS, position.column)}>›</button>
        </div> : null}
      </> : null}
    </>}
  </div>
}

function clamp(value: number, minimum: number, maximum: number): number { return Math.max(minimum, Math.min(maximum, value)) }
function cellText(cell: PreviewDocumentCell): string { return cell.noSavedValue ? 'No saved value' : cell.text }
function columnLabel(column: number): string {
  let value = column + 1
  let label = ''
  while (value > 0) { value--; label = String.fromCharCode(65 + value % 26) + label; value = Math.floor(value / 26) }
  return label
}
function partialTableDescription(table: PreviewDocumentTable): string {
  return `Showing ${table.rows.length.toLocaleString()} rows and ${table.columnCount.toLocaleString()} columns${table.sourceTruncated ? ' from part of the file' : ''}. More cells are outside this view.`
}
