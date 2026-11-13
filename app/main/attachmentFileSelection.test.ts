import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { selectAttachmentFile } from './attachmentFileSelection.js'
import { createAttachmentFileTokenStore } from './mainDecisions.js'
import { MAX_ATTACHMENT_SOURCE_IMAGE_BYTES } from '../shared/hostApi.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'attachment-selection-'))
  roots.push(root)
  return root
}

test('regular files mint session-bound tokens for canonical paths', () => {
  const root = fixture()
  const path = join(root, 'notes.txt')
  writeFileSync(path, 'hello')
  symlinkSync(path, join(root, 'alias'))
  const store = createAttachmentFileTokenStore()
  const selected = selectAttachmentFile('session', join(root, 'alias'), store.mint)
  expect(selected.kind).toBe('file')
  if (selected.kind !== 'file') throw new Error('expected file')
  expect(selected.name).toBe('notes.txt')
  expect(store.resolve('session', selected.token)).toBe(realpathSync(path))
  expect(store.resolve('other', selected.token)).toBeUndefined()
})

test('rejects untrusted paths, folders, missing files and quote-bearing targets without minting', () => {
  const root = fixture()
  const quoted = join(root, 'bad"name')
  writeFileSync(quoted, 'text')
  symlinkSync(quoted, join(root, 'alias'))
  mkdirSync(join(root, 'folder'))
  const mint = () => { throw new Error('must not mint') }
  for (const path of [null, {}, '', 'relative.txt', join(root, 'missing'), join(root, 'folder'), quoted, join(root, 'alias')]) {
    expect(selectAttachmentFile('session', path, mint).kind).toBe('error')
  }
  expect(selectAttachmentFile(null, root, mint).kind).toBe('error')
})

test('sniffs image headers rather than trusting file names', () => {
  const root = fixture()
  const path = join(root, 'not-an-image.txt')
  writeFileSync(path, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]))
  const selected = selectAttachmentFile('session', path, () => { throw new Error('must not mint') })
  expect(selected.kind).toBe('image')
  if (selected.kind === 'image') expect(selected.mediaType).toBe('image/png')
  truncateSync(path, MAX_ATTACHMENT_SOURCE_IMAGE_BYTES + 1)
  expect(selectAttachmentFile('session', path, () => { throw new Error('must not mint') })).toEqual({
    kind: 'error', message: 'This image is too large to attach.',
  })
})
