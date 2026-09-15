import { afterEach, expect, test } from 'bun:test'
import {
  prepareImageAttachment,
  selectAttachableImageFile,
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

test('keeps a small accepted image without decoding or recompressing it', async () => {
  installFileReader('data:image/png;base64,AAAA')
  let decoded = false
  Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    value: async () => {
      decoded = true
      throw new Error('small images should not be decoded')
    },
  })
  const file = new File(['small'], 'cat.png', { type: 'image/png' })

  await expect(prepareImageAttachment(file)).resolves.toEqual({
    mediaType: 'image/png',
    data: 'AAAA',
    name: 'cat.png',
  })
  expect(decoded).toBe(false)
})

test('compresses an accepted image whose original base64 exceeds the submit budget', async () => {
  let reads = 0
  installFileReader(`data:image/png;base64,${'A'.repeat(90_001)}`, () => reads++)
  let closed = false
  Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    value: async () => ({
      width: 2_000,
      height: 1_000,
      close: () => {
        closed = true
      },
    }),
  })
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => {} }),
    toDataURL: () => 'data:image/jpeg;base64,BBBB',
  }
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => canvas },
  })
  const file = new File(['large'], 'cat.png', { type: 'image/png' })
  Object.defineProperty(file, 'size', { value: 100_000 })

  await expect(prepareImageAttachment(file)).resolves.toEqual({
    mediaType: 'image/jpeg',
    data: 'BBBB',
    name: 'cat.png',
  })
  expect(canvas.width).toBe(1_600)
  expect(canvas.height).toBe(800)
  expect(closed).toBe(true)
  expect(reads).toBe(0)
})

// CC-84 — a Finder drag exposes its payload on `dataTransfer.files`, never on
// `text/plain`, so the composer's text-only drop handler returned early and the
// drop did nothing at all. This is the selection half of the fix.
test('picks the accepted image out of a dropped file list', () => {
  const png = new File(['x'], 'shot.png', { type: 'image/png' })
  const notes = new File(['x'], 'notes.txt', { type: 'text/plain' })

  expect(selectAttachableImageFile([notes, png])).toBe(png)
})

test('prefers an accepted type over an unsupported image', () => {
  const heic = new File(['x'], 'shot.heic', { type: 'image/heic' })
  const webp = new File(['x'], 'shot.webp', { type: 'image/webp' })

  expect(selectAttachableImageFile([heic, webp])).toBe(webp)
})

// Handed on rather than dropped, so `prepareImageAttachment` answers with the
// same "Choose a PNG, JPEG, GIF, or WebP image." the picker path gives.
test('still surfaces an unsupported image so the user gets told why', () => {
  const heic = new File(['x'], 'shot.heic', { type: 'image/heic' })

  expect(selectAttachableImageFile([heic])).toBe(heic)
})

// Scope is strictly images: making a dropped file into a path the engine reads
// would put the renderer in charge of authoring a filesystem path (HC1).
test('ignores non-image files entirely', () => {
  expect(
    selectAttachableImageFile([
      new File(['x'], 'notes.txt', { type: 'text/plain' }),
      new File(['x'], 'report.pdf', { type: 'application/pdf' }),
      new File(['x'], 'unknown', { type: '' }),
    ]),
  ).toBeNull()
  expect(selectAttachableImageFile([])).toBeNull()
})
