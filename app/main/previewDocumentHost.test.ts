import { expect, test } from 'bun:test'
import type { FilePreviewDescriptor } from '../shared/filePreview.js'
import type { PreviewDocumentTableResult } from '../shared/previewDocument.js'
import { createPreviewDocumentHost } from './previewDocumentHost.js'

const id = 'a'.repeat(48)
const descriptor: FilePreviewDescriptor = { id, appSessionId: 's', path: '/tmp/book.xlsx', displayPath: 'book.xlsx', kind: 'xlsx', revision: 1, url: '' }
const emptyTable: PreviewDocumentTableResult = { ok: true, kind: 'table', table: {
  rows: [], columnCount: 0, rowOffset: 0, columnOffset: 0, truncated: false, sourceTruncated: false, sheets: [], merges: [],
} }

test('document requests use closed preview identities and cannot choose paths or reinterpret a snapshot', async () => {
  const snapshots: Array<[string, number]> = []
  const parsed: string[] = []
  const host = createPreviewDocumentHost({
    snapshot: async (id, revision) => { snapshots.push([id, revision]); return { descriptor, bytes: new Uint8Array([1, 2]) } },
    authorized: async () => true,
    table: async input => { parsed.push(input.format); return emptyTable },
    abort: () => {},
  })
  const valid = { id, revision: 1, request: { kind: 'table' } }
  for (const payload of [null, [], {}, { ...valid, path: '/tmp/secret' }, { ...valid, revision: 0 }, { ...valid, id: 'bad' }, { ...valid, request: { kind: 'table', path: '/tmp/secret' } }, Object.assign(Object.create({ id, revision: 1 }), { request: { kind: 'table' }, extra: 1, other: 2 })]) {
    expect(await host.read(payload)).toEqual({ ok: false, reason: 'refused' })
  }
  expect(snapshots).toEqual([])
  expect(await host.read({ ...valid, request: { kind: 'pdf' } })).toEqual({ ok: false, reason: 'refused' })
  expect(parsed).toEqual([])
  expect(await host.read(valid)).toEqual(emptyTable)
  expect(parsed).toEqual(['xlsx'])
  await host.abort()
})

test('document data is withheld if preview authority changes while parsing', async () => {
  let authorized = true
  let finish!: (result: PreviewDocumentTableResult) => void
  let started!: () => void
  const parsing = new Promise<void>(resolve => { started = resolve })
  const host = createPreviewDocumentHost({
    snapshot: async () => ({ descriptor, bytes: new Uint8Array([1]) }),
    authorized: async () => authorized,
    table: () => { started(); return new Promise(resolve => { finish = resolve }) },
    abort: () => {},
  })
  const pending = host.read({ id, revision: 1, request: { kind: 'table' } })
  await parsing
  authorized = false
  finish(emptyTable)
  expect(await pending).toEqual({ ok: false, reason: 'refused' })
})

test('release cancels a pending preview without cancelling a different preview', async () => {
  let finish!: (result: PreviewDocumentTableResult) => void
  let started!: () => void
  const parsing = new Promise<void>(resolve => { started = resolve })
  let aborted = 0
  const host = createPreviewDocumentHost({
    snapshot: async () => ({ descriptor, bytes: new Uint8Array([1]) }),
    authorized: async () => true,
    table: () => { started(); return new Promise(resolve => { finish = resolve }) },
    abort: () => { aborted++ },
  })
  const pending = host.read({ id, revision: 1, request: { kind: 'table' } })
  await parsing
  expect(aborted).toBe(0)
  await host.abort('b'.repeat(48))
  expect(aborted).toBe(0)
  await host.abort(id)
  expect(aborted).toBe(1)
  finish(emptyTable)
  expect(await pending).toEqual({ ok: false, reason: 'cancelled' })
})


test('completed table reads retain one warm owner across sheets and close its idle worker on release', async () => {
  let aborted = 0
  const host = createPreviewDocumentHost({
    snapshot: async () => ({ descriptor, bytes: new Uint8Array([1]) }),
    authorized: async () => true,
    table: async () => emptyTable,
    abort: async () => { aborted++ },
  })
  for (const sheet of ['First', 'Second']) expect(await host.read({ id, revision: 1, request: { kind: 'table', sheet } })).toEqual(emptyTable)
  expect(aborted).toBe(0)
  await host.abort('b'.repeat(48))
  expect(aborted).toBe(0)
  await host.abort(id)
  expect(aborted).toBe(1)
})

test('an idle table worker is retired when its retained preview loses authority', async () => {
  let authorized = true
  let retired!: () => void
  const stopped = new Promise<void>(resolve => { retired = resolve })
  const host = createPreviewDocumentHost({
    snapshot: async () => ({ descriptor, bytes: new Uint8Array([1]) }),
    authorized: async () => authorized,
    table: async () => emptyTable,
    abort: () => { retired() },
  })
  expect(await host.read({ id, revision: 1, request: { kind: 'table' } })).toEqual(emptyTable)
  authorized = false
  await Promise.race([stopped, Bun.sleep(1900).then(() => { throw new Error('Idle worker was not retired') })])
  await host.abort()
})

test('a truncated CSV tail never reaches the record parser', async () => {
  let parsed = false
  const host = createPreviewDocumentHost({
    snapshot: async () => ({ descriptor: { ...descriptor, kind: 'text', path: '/tmp/data.csv',
      textWindow: { side: 'end', truncated: true, totalBytes: 3000000, shownBytes: 2000000, invalidUtf8: false, firstLine: null } }, bytes: new Uint8Array([1]) }),
    authorized: async () => true,
    table: async () => { parsed = true; return emptyTable },
    abort: () => {},
  })
  expect(await host.read({ id, revision: 1, request: { kind: 'table' } })).toEqual({ ok: false, reason: 'refused' })
  expect(parsed).toBe(false)
})
