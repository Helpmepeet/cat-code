import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import type { FilePreviewDescriptor } from '../../shared/filePreview.js'
import type { FilePreviewDocumentRequest, FilePreviewDocumentResult, PreviewDocumentTable } from '../../shared/previewDocument.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { TableDocumentView } from './TableDocumentView.js'

let harness: DomTestHarness
let previousBridge: PropertyDescriptor | undefined
let previousClipboard: PropertyDescriptor | undefined
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => {
  await harness.unmountAll()
  window.getSelection()?.removeAllRanges()
  if (previousBridge) Object.defineProperty(window, 'catcode', previousBridge)
  else Reflect.deleteProperty(window, 'catcode')
  if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
})
afterAll(async () => { await harness.teardown() })

const descriptor: FilePreviewDescriptor = {
  id: 'table-fixture', appSessionId: 'table-session', revision: 1,
  kind: 'text', path: '/reports/data.csv', displayPath: '/reports/data.csv', url: '', text: '00123,9007199254740993\n',
}
function table(rows = 1, columns = 4): PreviewDocumentTable {
  return {
    rows: Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, column) => ({ text: `${row + 1}:${column + 1}` }))),
    columnCount: columns, rowOffset: 0, columnOffset: 0, totalRows: rows,
    truncated: false, sourceTruncated: false, sheets: [], merges: [],
  }
}
function install(read: (request: FilePreviewDocumentRequest) => Promise<FilePreviewDocumentResult>) {
  previousBridge = Object.getOwnPropertyDescriptor(window, 'catcode')
  previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(window, 'catcode', { configurable: true, value: {
    readFilePreviewDocument: async (_id: string, _revision: number, request: FilePreviewDocumentRequest) => read(request),
  } })
}
async function key(element: Element, value: string) {
  await act(async () => { element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: value })) })
}

test('keyboard crosses row pages and reaches the last of 100 columns without mounting more than 5,000 cells', async () => {
  const model = table(101, 100)
  model.rowOffset = 100
  model.sourceTruncated = true
  install(async () => ({ ok: true, kind: 'table', table: model }))
  const positions: unknown[] = []
  const tree = await harness.mount(<TableDocumentView file={descriptor} active initialPosition={{ row: 149, column: 99 }} onPosition={value => positions.push(value)} />)
  const grid = tree.container.querySelector<HTMLElement>('[role="grid"]')!
  expect(grid).not.toBeNull()
  const partial = tree.container.querySelector<HTMLElement>('[aria-label="Partial table"]')!
  expect(partial).not.toBeNull()
  expect(partial.textContent).toBe('Partial')
  expect(partial.title).toContain('101 rows and 100 columns from part of the file')
  expect(partial.getAttribute('aria-description')).toContain('More cells are outside this view')
  expect(tree.container.textContent).not.toContain('More cells are outside this view')
  expect(tree.container.querySelector('.table-document-coordinate')?.textContent).toBe('CV150')
  expect(tree.container.querySelectorAll('[role="gridcell"]')).toHaveLength(5_000)
  await key(grid, 'ArrowDown')
  expect(tree.container.querySelector('.table-document-coordinate')?.textContent).toBe('CV151')
  const active = tree.container.querySelector(`[id="${grid.getAttribute('aria-activedescendant')}"]`)
  expect(active?.textContent).toBe('51:100')
  expect(active?.getAttribute('aria-selected')).toBe('true')
  expect(tree.container.querySelector('.table-document-pages')?.textContent).toContain('151–200 of 201')
  await key(grid, 'Home')
  expect(tree.container.querySelector('.table-document-coordinate')?.textContent).toBe('A151')
  await key(grid, 'End')
  await key(grid, 'PageDown')
  expect(tree.container.querySelector('.table-document-coordinate')?.textContent).toBe('CV201')
  expect(tree.container.querySelectorAll('[role="gridcell"]')).toHaveLength(100)
  expect(positions.at(-1)).toEqual({ table: { row: 200, column: 99, mode: 'table' } })
})

test('values stay inert, formula details remain readable, and a text selection survives a cell click', async () => {
  const model = table()
  model.rows[0] = [
    { text: '00123' }, { text: '9007199254740993' },
    { text: '<a href="javascript:alert(1)">link</a>' }, { text: '', formula: 'A1+B1', noSavedValue: true },
  ]
  model.merges = [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 1 }]
  install(async () => ({ ok: true, kind: 'table', table: model }))
  const copied: string[] = []
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { copied.push(value) } } })
  const tree = await harness.mount(<TableDocumentView file={descriptor} active />)
  const cells = [...tree.container.querySelectorAll<HTMLTableCellElement>('[role="gridcell"]')]
  expect(cells[0]?.textContent).toBe('00123')
  expect(cells[1]?.textContent).toBe('9007199254740993')
  expect(cells[2]?.textContent).toBe(model.rows[0]![2]!.text)
  expect(tree.container.querySelector('a')).toBeNull()
  expect(tree.container.querySelector('.table-document-merge')?.textContent).toBe('Merged A1:B1')
  const range = document.createRange()
  range.selectNodeContents(cells[2]!)
  window.getSelection()!.addRange(range)
  await act(async () => { cells[2]!.click() })
  expect(tree.container.querySelector('.table-document-coordinate')?.textContent).toBe('A1')
  expect(window.getSelection()?.toString()).toBe(model.rows[0]![2]!.text)
  const selectedCopy = new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true, cancelable: true })
  await act(async () => { tree.container.querySelector('[role="grid"]')!.dispatchEvent(selectedCopy) })
  expect(selectedCopy.defaultPrevented).toBe(false)
  expect(copied).toEqual([])
  window.getSelection()?.removeAllRanges()
  await act(async () => { cells[3]!.click() })
  expect(tree.container.querySelector('.table-document-value')?.textContent).toContain('No saved value=A1+B1')
  await act(async () => { tree.container.querySelector<HTMLButtonElement>('[aria-label="Copy cell value"]')!.click() })
  expect(copied).toEqual(['No saved value'])
  await act(async () => { tree.container.querySelector('[role="grid"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true, cancelable: true })) })
  expect(copied).toEqual(['No saved value', 'No saved value'])
})

test('a pending sheet keeps the previous grid and selector until the newest request finishes', async () => {
  const names = Array.from({ length: 50 }, (_, index) => `Quarter ${index + 1} forecast and actual expenses`)
  const make = (sheet: string) => ({ ...table(), sheet, sheets: names.map(name => ({ name })), rows: [[{ text: sheet }]] })
  const pending = new Map<string, (value: FilePreviewDocumentResult) => void>()
  install(async request => {
    const sheet = request.kind === 'table' ? request.sheet ?? names[0]! : names[0]!
    if (sheet === names[0]) return { ok: true, kind: 'table', table: make(sheet) }
    return new Promise(resolve => pending.set(sheet, resolve))
  })
  const tree = await harness.mount(<TableDocumentView file={{ ...descriptor, path: '/reports/workbook.xlsx' }} active />)
  const selector = tree.container.querySelector<HTMLSelectElement>('[aria-label="Sheet"]')!
  expect(selector.options).toHaveLength(50)
  const choose = async (name: string) => act(async () => { selector.value = name; selector.dispatchEvent(new Event('change', { bubbles: true })) })
  await choose(names[1]!)
  expect(selector.value).toBe(names[0]!)
  expect(tree.container.querySelector('[role="gridcell"]')?.textContent).toBe(names[0]!)
  await choose(names[2]!)
  await act(async () => { pending.get(names[2]!)!({ ok: true, kind: 'table', table: make(names[2]!) }) })
  expect(selector.value).toBe(names[2]!)
  await act(async () => { pending.get(names[1]!)!({ ok: true, kind: 'table', table: make(names[1]!) }) })
  expect(selector.value).toBe(names[2]!)
  expect(tree.container.querySelector('[role="gridcell"]')?.textContent).toBe(names[2]!)
})

test('a CSV line citation opens Source and notifies readiness without parsing a table', async () => {
  let requests = 0
  let ready = 0
  install(async () => { requests++; return { ok: true, kind: 'table', table: table() } })
  const tree = await harness.mount(<TableDocumentView file={descriptor} active={false} lineTarget={{ line: 1, token: 1 }} onReady={() => ready++} />)
  await act(async () => { await harness.nextFrame(); await harness.nextFrame() })
  expect(tree.container.querySelector('[aria-label="Search file"]')).not.toBeNull()
  expect(tree.container.querySelector('[role="grid"]')).toBeNull()
  expect(requests).toBe(0)
  expect(ready).toBe(1)
  const windows: string[] = []
  await tree.render(<TableDocumentView file={{ ...descriptor, textWindow: { side: 'end', truncated: true, totalBytes: 3_000_000, shownBytes: 2_000_000, invalidUtf8: true, firstLine: null } }} active
    onTextWindow={side => windows.push(side)} />)
  const tableButton = [...tree.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Table')!
  expect(tableButton.disabled).toBe(true)
  expect(requests).toBe(0)
  expect(tree.container.textContent).toContain('Some bytes are not valid UTF-8.')
  expect(tree.container.textContent).not.toContain('Showing the last')
  expect(tree.container.textContent).not.toContain('Table view starts')
  await act(async () => { tree.container.querySelector<HTMLButtonElement>('button[aria-label="Show start"]')!.click() })
  expect(windows).toEqual(['start'])
})

test('an unfinished or failed document cannot report a useful paint', async () => {
  let finish!: (value: FilePreviewDocumentResult) => void
  let ready = 0
  let failures = 0
  install(async () => new Promise(resolve => { finish = resolve }))
  const tree = await harness.mount(<TableDocumentView file={descriptor} active={false} onReady={() => ready++} onFailure={() => failures++} />)
  await act(async () => { await harness.nextFrame(); await harness.nextFrame() })
  expect(ready).toBe(0)
  await act(async () => { finish({ ok: false, reason: 'invalid' }) })
  expect(failures).toBe(1)
  expect(ready).toBe(0)
  expect(tree.container.querySelector('[role="grid"]')).toBeNull()
  await tree.render(<TableDocumentView file={{ ...descriptor, revision: 2 }} active={false} onReady={() => ready++} onFailure={() => failures++} />)
  await act(async () => { finish({ ok: true, kind: 'table', table: table() }) })
  await act(async () => { await harness.nextFrame(); await harness.nextFrame() })
  expect(ready).toBe(1)
})
