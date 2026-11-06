import { expect, test } from 'bun:test'
import * as XLSX from 'xlsx'
import { parsePreviewDocument } from './previewDocumentParser.js'
import { parseFilePreviewDocumentRequest, parsePreviewDocumentTableResult, parsePreviewDocumentWorkerRequest, type PreviewDocumentWorkerRequest } from '../shared/previewDocument.js'
const request = (text: string, format: 'csv' | 'tsv' = 'csv'): PreviewDocumentWorkerRequest => ({ format, bytes: Buffer.from(text).toString('base64') })

test('delimited preview preserves records and strings without evaluating formulas or sep directives', () => {
  const result = parsePreviewDocument(request('sep=,\n00123,9007199254740993,"first\nsecond",=SUM(A1:A2)\n'))
  expect(result).toMatchObject({ ok: true, kind: 'table', table: { rows: [[{ text: 'sep=' }, { text: '' }], [{ text: '00123' }, { text: '9007199254740993' }, { text: 'first\nsecond' }, { text: '=SUM(A1:A2)' }]], totalRows: 2, truncated: false } })
  expect(parsePreviewDocument(request('00123\t=1+1\n', 'tsv'))).toMatchObject({ ok: true, table: { rows: [[{text:'00123'}, {text:'=1+1'}]] } })
  expect(parsePreviewDocument(request('"unfinished'))).toEqual({ ok: false, reason: 'invalid' })
  expect(parsePreviewDocument(request('a\n\n""\n'))).toMatchObject({ok:true,table:{rows:[[{text:'a'}],[{text:''}],[{text:''}]],totalRows:3}})
})
test('table budgets show a bounded prefix and pathological record allocation is refused', () => {
  const columns = Array.from({length: 101}, (_, index) => String(index)).join(',')
  const result = parsePreviewDocument(request(`${columns}\n${columns}`))
  expect(result.ok && result.kind === 'table' ? result.table.rows[0]?.length : 0).toBe(100)
  expect(result).toMatchObject({ ok: true, table: { truncated: true, columnCount: 100 } })
  const rows = parsePreviewDocument(request(Array.from({length: 2001}, (_, i) => String(i)).join('\n')))
  expect(rows.ok ? rows.table.rows.length : 0).toBe(2000)
  expect(rows).toMatchObject({ ok: true, table: { truncated: true } })
  const dense = parsePreviewDocument(request(Array.from({length:1001},()=>Array(100).fill('x').join(',')).join('\n')))
  expect(dense.ok && dense.table.rows.length).toBe(1000)
  expect(dense).toMatchObject({ok:true,table:{truncated:true,columnCount:100}})
  expect(parsePreviewDocument(request('a,'.repeat(10_001)))).toEqual({ok:false,reason:'limit'})
  expect(parsePreviewDocument(request('a'.repeat(1_048_578)))).toEqual({ok:false,reason:'limit'})
  expect(parsePreviewDocument({...request('a\nb'),sourceTruncated:true})).toMatchObject({ok:true,table:{sourceTruncated:true,truncated:true}})
  expect(parsePreviewDocument({...request('complete,00123\n\"unfinished\nvalue'),sourceTruncated:true})).toMatchObject({ok:true,table:{rows:[[{text:'complete'},{text:'00123'}]],sourceTruncated:true,truncated:true}})
})
function workbookBytes(): Buffer {
  const book = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet([['00123', 12.5, 45292, '#DIV/0!', 'text']])
  sheet.B1 = { t:'n', v:12.5, z:'$0.00' }
  sheet.C1 = { t:'n', v:45292, z:'yyyy-mm-dd' }
  sheet.D1 = { t:'e', v:7 }
  sheet.E1 = { t:'n', f:'SUM(B1:B2)' }
  sheet['!merges'] = [{s:{r:1,c:0},e:{r:1,c:1}}]
  XLSX.utils.book_append_sheet(book,sheet,'Summary')
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['private']]),'Hidden')
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['second']]),'Quarter forecast with long name')
  book.Workbook = {Sheets:[{name:'Summary',Hidden:0},{name:'Hidden',Hidden:1},{name:'Quarter forecast with long name',Hidden:0}]}
  return XLSX.write(book,{type:'buffer',bookType:'xlsx',compression:false})
}
test('XLSX uses stored formatted values, visible sheets, and inert formula metadata', () => {
  const bytes = workbookBytes().toString('base64')
  const result = parsePreviewDocument({format:'xlsx',bytes})
  expect(result).toMatchObject({ok:true,table:{sheet:'Summary',sheets:[{name:'Summary'},{name:'Quarter forecast with long name'}],rows:[[{text:'00123'},{text:'$12.50'},{text:'2024-01-01'},{text:'#DIV/0!'},{text:'',formula:'SUM(B1:B2)',noSavedValue:true}]]}})
  expect(parsePreviewDocument({format:'xlsx',bytes,sheet:'Quarter forecast with long name'})).toMatchObject({ok:true,table:{sheet:'Quarter forecast with long name',rows:[[{text:'second'}]]}})
  expect(parsePreviewDocument({format:'xlsx',bytes,sheet:'Hidden'})).toEqual({ok:false,reason:'invalid'})
})
test('a formula without cached XML value remains visible when the library drops its cell', () => {
  const bytes = workbookBytes()
  const original = Buffer.from('<c r="E1" t="n">')
  let at = bytes.indexOf(original)
  if(at < 0) { const alternate=Buffer.from('<c r="E1" t="e">'); at=bytes.indexOf(alternate); expect(at).toBeGreaterThan(0) }
  expect(at).toBeGreaterThan(0)
  Buffer.from('<c r="E1"      >').copy(bytes,at)
  expect(XLSX.read(bytes,{type:'buffer'}).Sheets.Summary!.E1).toBeUndefined()
  expect(parsePreviewDocument({format:'xlsx',bytes:bytes.toString('base64')})).toMatchObject({ok:true,table:{rows:[[{text:'00123'},{text:'$12.50'},{text:'2024-01-01'},{text:'#DIV/0!'},{text:'',formula:'SUM(B1:B2)',noSavedValue:true}]]}})
})
test('formula caches distinguish empty numeric values from saved zero and empty strings', () => {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, {
    A1: {t:'n', f:'1+1', v:''}, B1: {t:'n', f:'2+2', v:''},
    C1: {t:'n', f:'1-1', v:0}, D1: {t:'s', f:'IF(1,"","x")', v:''},
    E1: {t:'s', f:'IF(1,"","y")', v:''}, F1: {t:'n', f:'3+3'}, '!ref':'A1:F1',
  }, 'Caches')
  const produced = XLSX.write(book, {type:'buffer', bookType:'xlsx', compression:false}) as Buffer
  const archive = XLSX.CFB.read(produced, {type:'buffer'})
  const entry = archive.FileIndex[archive.FullPaths.findIndex((path:string) => path.endsWith('/xl/worksheets/sheet1.xml'))]
  // Re-encode valid ZIP entries with the other legal spelling of an empty value.
  const xml = Buffer.from(entry.content).toString('utf8').replace(/(<c r="[BE]1"[^>]*>[\s\S]*?)<v><\/v>/g, '$1<v/>')
  entry.content = Buffer.from(xml); entry.size = entry.content.length
  const bytes = XLSX.CFB.write(archive, {type:'buffer', fileType:'zip'}) as Buffer
  expect(parsePreviewDocument({format:'xlsx', bytes:bytes.toString('base64')})).toMatchObject({ok:true,table:{rows:[[
    {text:'',formula:'1+1',noSavedValue:true}, {text:'',formula:'2+2',noSavedValue:true},
    {text:'0',formula:'1-1'}, {text:'',formula:'IF(1,"","x")'},
    {text:'',formula:'IF(1,"","y")'}, {text:'',formula:'3+3',noSavedValue:true},
  ]]}})
  const result = parsePreviewDocument({format:'xlsx', bytes:bytes.toString('base64')})
  if (!result.ok) throw new Error('Producer workbook was refused')
  for (const column of [2,3,4]) expect(result.table.rows[0]![column]!.noSavedValue).toBeUndefined()
})
test('XLSX bounds start at the used range instead of the absolute row number', () => {
  for (const row of [1999,2000,2001,5000]) {
    const book = XLSX.utils.book_new()
    const address = XLSX.utils.encode_cell({r:row-1,c:2})
    XLSX.utils.book_append_sheet(book, {[address]:{t:'s',v:`row ${row}`},'!ref':address},'Offset')
    const bytes = XLSX.write(book,{type:'buffer',bookType:'xlsx'}) as Buffer
    expect(parsePreviewDocument({format:'xlsx',bytes:bytes.toString('base64')}),address).toMatchObject({ok:true,table:{
      rows:[[{text:`row ${row}`}]],rowOffset:row-1,columnOffset:2,columnCount:1,totalRows:1,truncated:false,
    }})
  }
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, {A1:{t:'s',v:'first'},A5000:{t:'s',v:'last'},'!ref':'A1:A5000'},'Bounded')
  const bytes = XLSX.write(book,{type:'buffer',bookType:'xlsx'}) as Buffer
  const result = parsePreviewDocument({format:'xlsx',bytes:bytes.toString('base64')})
  expect(result).toMatchObject({ok:true,table:{rowOffset:0,totalRows:5000,truncated:true}})
  expect(result.ok && result.table.rows.length).toBe(2000)
  expect(result.ok && result.table.rows[0]).toEqual([{text:'first'}])
})
test('a damaged worksheet fails the preview instead of silently disappearing', () => {
  const bytes = workbookBytes()
  const original = Buffer.from('<f>SUM(B1:B2)</f>')
  const at = bytes.indexOf(original)
  expect(at).toBeGreaterThan(0)
  Buffer.from('<f t="array">1</f>'.padEnd(original.length, ' ')).copy(bytes, at)
  // The default reader suppresses this missing array-formula reference.
  expect(XLSX.read(bytes, {type:'buffer'}).Sheets.Summary).toBeUndefined()
  expect(parsePreviewDocument({format:'xlsx',bytes:bytes.toString('base64')})).toEqual({ok:false,reason:'invalid'})
})
test('ZIP entry and expansion declarations fail closed before workbook parsing', () => {
  const bytes = workbookBytes()
  const end=bytes.length-22
  const many=Buffer.from(bytes);many.writeUInt16LE(2049,end+8);many.writeUInt16LE(2049,end+10)
  expect(parsePreviewDocument({format:'xlsx',bytes:many.toString('base64')})).toEqual({ok:false,reason:'limit'})
  const bomb=Buffer.from(bytes);const central=bomb.readUInt32LE(end+16);bomb.writeUInt32LE(128*1024*1024,central+24)
  expect(parsePreviewDocument({format:'xlsx',bytes:bomb.toString('base64')})).toEqual({ok:false,reason:'limit'})
  expect(parsePreviewDocument({format:'xlsx',bytes:bytes.subarray(0,-1).toString('base64')})).toEqual({ok:false,reason:'invalid'})
  const multi=Buffer.from(bytes);multi.writeUInt16LE(1,end+4)
  expect(parsePreviewDocument({format:'xlsx',bytes:multi.toString('base64')})).toEqual({ok:false,reason:'invalid'})
})
test('closed document boundaries reject added paths and malformed parser results', () => {
  expect(parseFilePreviewDocumentRequest({kind:'pdf',path:'/tmp/file'})).toBeNull()
  expect(parseFilePreviewDocumentRequest({kind:'table',sheet:'Summary'})).toEqual({kind:'table',sheet:'Summary'})
  expect(parsePreviewDocumentWorkerRequest({...request('a'),path:'/tmp/file'})).toBeNull()
  const result=parsePreviewDocument(request('a'))
  if(!result.ok)throw new Error('fixture failed')
  expect(parsePreviewDocumentTableResult({...result,table:{...result.table,rows:[[{text:'a',href:'javascript:evil'}]]}})).toBeNull()
  expect(parsePreviewDocumentTableResult({...result,table:{...result.table,columnCount:101}})).toBeNull()
})
