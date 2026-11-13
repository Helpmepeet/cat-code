import { expect, test } from 'bun:test'
import { classifyWindowDrop } from './windowDropModel.js'

const files = (...types: string[]) => types.map(type => ({ kind: 'file', type }))

test('counts accepted image MIME types without filenames', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
    expect(classifyWindowDrop(files(type), ['Files'])).toEqual({
      allowed: true, title: 'Drop to attach', detail: '1 image',
    })
  }
  expect(classifyWindowDrop(files('image/png', 'image/jpeg'), ['Files'])?.detail).toBe('2 images')
})

test('explains skipped files and unsupported formats', () => {
  expect(classifyWindowDrop(files('image/png', 'application/pdf', 'image/heic'), ['Files'])?.detail)
    .toBe('1 image · Other files are skipped')
  expect(classifyWindowDrop(files('image/heic'), ['Files'])).toEqual({
    allowed: false, title: "Can't attach this image", detail: 'Use PNG, JPEG, GIF, or WebP',
  })
  for (const items of [files('application/pdf'), files(''), []]) {
    expect(classifyWindowDrop(items, ['Files'])?.title).toBe("Can't attach this file")
  }
})

test('plain text qualifies but internal sidebar drags and rich-only content do not', () => {
  expect(classifyWindowDrop([], ['text/plain'])?.title).toBe('Drop to add text')
  for (const type of ['text/workspace-cwd', 'text/pinned-session-id']) {
    expect(classifyWindowDrop([], [type, 'text/plain'])).toBeNull()
  }
  expect(classifyWindowDrop([], ['text/html'])).toBeNull()
  expect(classifyWindowDrop([], [])).toBeNull()
})
