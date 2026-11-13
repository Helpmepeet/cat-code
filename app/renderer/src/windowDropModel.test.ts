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

test('accepts one file with images and explains unsupported formats', () => {
  expect(classifyWindowDrop(files('image/png', 'application/pdf', 'image/heic'), ['Files'])?.detail)
    .toBe('1 image and 1 file')
  expect(classifyWindowDrop(files('image/heic'), ['Files'])).toEqual({
    allowed: false, title: "Can't attach this image", detail: 'Use PNG, JPEG, GIF, or WebP',
  })
  for (const items of [files('application/pdf'), files(''), []]) {
    expect(classifyWindowDrop(items, ['Files'])?.detail).toBe('1 file')
  }
  expect(classifyWindowDrop(files('application/pdf', ''), ['Files'])).toEqual({
    allowed: false, title: "Can't attach these files", detail: 'Attach one file at a time',
  })
  expect(classifyWindowDrop(files('image/png', '', ''), ['Files'])?.allowed).toBe(false)
})

test('labels follow the user-visible text rules', () => {
  const shapes: [ReturnType<typeof files>, string[]][] = [
    [files('image/png'), ['Files']], [files('image/heic'), ['Files']], [files('application/pdf'), ['Files']],
    [files('application/pdf', ''), ['Files']], [files('image/png', 'text/csv'), ['Files']], [[], ['text/plain']],
  ]
  for (const [items, types] of shapes) {
    const feedback = classifyWindowDrop(items, types)!
    expect(`${feedback.title} ${feedback.detail}`).not.toMatch(/[—–]/)
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
