import { expect, test } from 'bun:test'
import {
  decodeImageDataUrl,
  MAX_SAVED_IMAGE_BYTES,
  planContextMenu,
} from './contextMenuPolicy.js'

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const base = { mediaType: 'none', srcURL: '', isEditable: false, selectionText: '' }

test('decodes a base64 png data URL to its bytes and extension', () => {
  const decoded = decodeImageDataUrl(PNG_1PX)
  expect(decoded?.extension).toBe('png')
  expect(decoded?.bytes.subarray(1, 4).toString('ascii')).toBe('PNG')
})

test('maps jpeg to jpg', () => {
  expect(decodeImageDataUrl('data:image/jpeg;base64,/9j/4AAQ')?.extension).toBe('jpg')
})

test('refuses non-data, non-image, unknown-type, empty, and oversized sources', () => {
  expect(decodeImageDataUrl('https://example.com/a.png')).toBeNull()
  expect(decodeImageDataUrl('file:///etc/passwd')).toBeNull()
  expect(decodeImageDataUrl('data:text/html;base64,PGI+')).toBeNull()
  expect(decodeImageDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull()
  expect(decodeImageDataUrl('data:image/png;base64,')).toBeNull()
  const oversized = 'A'.repeat(Math.ceil((MAX_SAVED_IMAGE_BYTES / 3) * 4) + 8)
  expect(decodeImageDataUrl(`data:image/png;base64,${oversized}`)).toBeNull()
})

test('an inline image offers copy and save', () => {
  expect(planContextMenu({ ...base, mediaType: 'image', srcURL: PNG_1PX })).toEqual({
    copyImage: true,
    saveImage: true,
    edit: 'none',
  })
})

test('an image that cannot be decoded still offers copy but not save', () => {
  expect(
    planContextMenu({ ...base, mediaType: 'image', srcURL: 'http://localhost:5173/logo.png' }),
  ).toEqual({ copyImage: true, saveImage: false, edit: 'none' })
})

test('text targets offer edit actions and never image actions', () => {
  expect(planContextMenu({ ...base, selectionText: 'hi' }).edit).toBe('selection')
  expect(planContextMenu({ ...base, isEditable: true }).edit).toBe('editable')
  expect(planContextMenu({ ...base, selectionText: 'hi' }).copyImage).toBe(false)
  expect(planContextMenu(base)).toEqual({ copyImage: false, saveImage: false, edit: 'none' })
})
