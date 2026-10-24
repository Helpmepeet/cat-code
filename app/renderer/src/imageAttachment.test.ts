import { afterEach, expect, test } from 'bun:test'
import { MAX_SUBMIT_IMAGE_BYTES } from '../../../src/app-runtime/appSubmitLimits.js'
import {
  prepareImageAttachment,
  selectAttachableImageFiles,
} from './imageAttachment.js'

const originalFileReader = Object.getOwnPropertyDescriptor(globalThis, 'FileReader')
const originalCreateImageBitmap = Object.getOwnPropertyDescriptor(
  globalThis,
  'createImageBitmap',
)
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor)
  else Reflect.deleteProperty(globalThis, name)
}

function installFileReader(result: string, onRead?: () => void): void {
  class TestFileReader {
    result: string | ArrayBuffer | null = null
    onerror: ((event: ProgressEvent<FileReader>) => void) | null = null
    onload: ((event: ProgressEvent<FileReader>) => void) | null = null

    readAsDataURL(): void {
      onRead?.()
      this.result = result
      this.onload?.({} as ProgressEvent<FileReader>)
    }
  }

  Object.defineProperty(globalThis, 'FileReader', {
    configurable: true,
    value: TestFileReader,
  })
}

afterEach(() => {
  restoreGlobal('FileReader', originalFileReader)
  restoreGlobal('createImageBitmap', originalCreateImageBitmap)
  restoreGlobal('document', originalDocument)
})

test('rejects an oversized source file before FileReader allocates it', async () => {
  let reads = 0
  installFileReader('data:image/png;base64,AAAA', () => reads++)
  const file = new File(['x'], 'huge.png', { type: 'image/png' })
  Object.defineProperty(file, 'size', { value: Number.MAX_SAFE_INTEGER })

  await expect(prepareImageAttachment(file)).rejects.toThrow(
    'This image is too large to attach.',
  )
  expect(reads).toBe(0)
})

test('keeps a detailed eligible image byte-identical without recompressing it', async () => {
  const data = 'A'.repeat(500_000)
  installFileReader(`data:image/png;base64,${data}`)
  let closed = false
  Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    value: async () => ({
      width: 2_000,
      height: 1_500,
      close: () => { closed = true },
    }),
  })
  const file = new File(['x'.repeat(375_000)], 'cat.png', { type: 'image/png' })

  await expect(prepareImageAttachment(file)).resolves.toEqual({
    mediaType: 'image/png',
    data,
    name: 'cat.png',
  })
  expect(closed).toBe(true)
})

test('resizes an oversized screenshot and preserves PNG encoding', async () => {
  let reads = 0
  installFileReader(`data:image/png;base64,${'A'.repeat(90_001)}`, () => reads++)
  let closed = false
  Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    value: async () => ({
      width: 4_000,
      height: 2_000,
      close: () => {
        closed = true
      },
    }),
  })
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => {} }),
    toDataURL: () => 'data:image/png;base64,BBBB',
  }
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => canvas },
  })
  const file = new File(['large'], 'cat.png', { type: 'image/png' })
  Object.defineProperty(file, 'size', { value: 100_000 })

  await expect(prepareImageAttachment(file)).resolves.toEqual({
    mediaType: 'image/png',
    data: 'BBBB',
    name: 'cat.png',
  })
  expect(canvas.width).toBe(2_000)
  expect(canvas.height).toBe(1_000)
  expect(closed).toBe(true)
  expect(reads).toBe(0)
})

test('uses WebP only when PNG exceeds the encoded ceiling', async () => {
  let closed = false
  Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    value: async () => ({
      width: 2_000, height: 2_000,
      close: () => { closed = true },
    }),
  })
  const encodings: string[] = []
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => ({
      getContext: () => ({ drawImage: () => {} }),
      toDataURL: (type: string) => {
        encodings.push(type)
        return `data:${type};base64,${'A'.repeat(
          type === 'image/png' ? MAX_SUBMIT_IMAGE_BYTES + 4 : MAX_SUBMIT_IMAGE_BYTES,
        )}`
      },
    }) },
  })
  const file = new File(['x'], 'large.png', { type: 'image/png' })
  Object.defineProperty(file, 'size', { value: 4 * 1024 * 1024 })
  const result = await prepareImageAttachment(file)
  expect(result.mediaType).toBe('image/webp')
  expect(result.data.length).toBe(MAX_SUBMIT_IMAGE_BYTES)
  expect(encodings).toEqual(['image/png', 'image/webp'])
  expect(closed).toBe(true)
})

test('closes the bitmap when canvas preparation fails', async () => {
  let closed = false
  Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    value: async () => ({
      width: 3_000, height: 2_000,
      close: () => { closed = true },
    }),
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => ({ getContext: () => null }) },
  })
  await expect(prepareImageAttachment(
    new File(['x'], 'shot.png', { type: 'image/png' }),
  )).rejects.toThrow('Could not prepare this image.')
  expect(closed).toBe(true)
})

test('refuses output that never fits and bounds encoding attempts', async () => {
  let closed = false
  let attempts = 0
  Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    value: async () => ({
      width: 2_000, height: 2_000,
      close: () => { closed = true },
    }),
  })
  const oversized = `data:image/jpeg;base64,${'A'.repeat(MAX_SUBMIT_IMAGE_BYTES + 4)}`
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => ({
      getContext: () => ({ drawImage: () => {} }),
      toDataURL: () => { attempts++; return oversized },
    }) },
  })
  const file = new File(['x'], 'large.jpg', { type: 'image/jpeg' })
  Object.defineProperty(file, 'size', { value: 4 * 1024 * 1024 })
  await expect(prepareImageAttachment(file)).rejects.toThrow('This image is too large to attach.')
  expect(attempts).toBe(20)
  expect(closed).toBe(true)
})

test('rejects extreme decoded dimensions before allocating a canvas', async () => {
  let closed = false
  Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    value: async () => ({
      width: 10_000, height: 10_000,
      close: () => { closed = true },
    }),
  })
  await expect(prepareImageAttachment(
    new File(['x'], 'shot.png', { type: 'image/png' }),
  )).rejects.toThrow('This image is too large to attach.')
  expect(closed).toBe(true)
})

test('rejects unsupported sources before decoding', async () => {
  await expect(prepareImageAttachment(
    new File(['x'], 'shot.heic', { type: 'image/heic' }),
  )).rejects.toThrow('Choose a PNG, JPEG, GIF, or WebP image.')
})

// CC-84 — a Finder drag exposes its payload on `dataTransfer.files`, never on
// `text/plain`, so the composer's text-only drop handler returned early and the
// drop did nothing at all. This is the selection half of the fix.
test('picks the accepted image out of a dropped file list', () => {
  const png = new File(['x'], 'shot.png', { type: 'image/png' })
  const notes = new File(['x'], 'notes.txt', { type: 'text/plain' })

  expect(selectAttachableImageFiles([notes, png])).toEqual([png])
})

test('prefers an accepted type over an unsupported image', () => {
  const heic = new File(['x'], 'shot.heic', { type: 'image/heic' })
  const webp = new File(['x'], 'shot.webp', { type: 'image/webp' })

  expect(selectAttachableImageFiles([heic, webp])).toEqual([webp])
})

// Handed on rather than dropped, so `prepareImageAttachment` answers with the
// same "Choose a PNG, JPEG, GIF, or WebP image." the picker path gives.
test('still surfaces an unsupported image so the user gets told why', () => {
  const heic = new File(['x'], 'shot.heic', { type: 'image/heic' })

  expect(selectAttachableImageFiles([heic])).toEqual([heic])
})

// Scope is strictly images: making a dropped file into a path the engine reads
// would put the renderer in charge of authoring a filesystem path (HC1).
test('ignores non-image files entirely', () => {
  expect(
    selectAttachableImageFiles([
      new File(['x'], 'notes.txt', { type: 'text/plain' }),
      new File(['x'], 'report.pdf', { type: 'application/pdf' }),
      new File(['x'], 'unknown', { type: '' }),
    ]),
  ).toEqual([])
  expect(selectAttachableImageFiles([])).toEqual([])
})
