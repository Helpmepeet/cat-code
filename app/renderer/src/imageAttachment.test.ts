import { afterEach, expect, test } from 'bun:test'
import { prepareImageAttachment } from './imageAttachment.js'

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
