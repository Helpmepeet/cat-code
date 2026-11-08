import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { act } from 'react'
import { PdfDocumentView } from './PdfDocumentView.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import type { FilePreviewDescriptor } from '../../shared/filePreview.js'

let harness: DomTestHarness
let renders = 0
let cancellations = 0
const page = {
  userUnit: 1,
  getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
  render: () => ({ promise: Promise.resolve(), cancel() {} }),
  streamTextContent() {},
  cleanup() {},
}
mock.module('./pdfDocumentRuntime.js', () => ({
  openPdfDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage: async () => page }), destroy: async () => {} }),
  TextLayer: class {
    container: HTMLElement
    constructor({ container }: { container: HTMLElement }) { this.container = container }
    async render() {
      const span = document.createElement('span')
      span.textContent = `render ${++renders}`
      this.container.append(span)
    }
    // Like PDF.js, cancellation deliberately leaves installed DOM intact.
    cancel() { cancellations++ }
  },
}))

let widthDescriptor: PropertyDescriptor | undefined
let contextDescriptor: PropertyDescriptor | undefined
let bridgeDescriptor: PropertyDescriptor | undefined
beforeAll(async () => {
  harness = await createDomTestHarness()
  widthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  contextDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')
  bridgeDescriptor = Object.getOwnPropertyDescriptor(window, 'catcode')
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 })
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => ({}) })
  Object.defineProperty(window, 'catcode', { configurable: true, writable: true, value: {
    readFilePreviewDocument: async () => ({ ok: true, kind: 'pdf', bytes: new Uint8Array() }),
  } })
})
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => {
  if (widthDescriptor) Object.defineProperty(HTMLElement.prototype, 'clientWidth', widthDescriptor)
  else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
  if (contextDescriptor) Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', contextDescriptor)
  else Reflect.deleteProperty(HTMLCanvasElement.prototype, 'getContext')
  if (bridgeDescriptor) Object.defineProperty(window, 'catcode', bridgeDescriptor)
  else Reflect.deleteProperty(window, 'catcode')
  mock.restore()
  await harness.teardown()
})

const file: FilePreviewDescriptor = {
  id: 'pdf', appSessionId: 'test', path: '/test.pdf', displayPath: 'test.pdf', kind: 'pdf', url: '', revision: 1,
}

test('zoom and fit width replace the old text DOM without a deferred cleanup erasing the new layer', async () => {
  const tree = await harness.mount(<PdfDocumentView file={file} active />)
  await act(async () => {})
  const text = tree.container.querySelector('.pdf-document-text')!
  expect(text.children.length).toBe(1)
  const zoom = tree.container.querySelector<HTMLSelectElement>('[aria-label="Zoom"]')!
  for (const value of ['1.25', '1.5', '2']) {
    await act(async () => {
      zoom.value = value
      zoom.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(text.children.length).toBe(1)
    expect(text.textContent).toBe(`render ${renders}`)
  }
  await act(async () => {
    Array.from(tree.container.querySelectorAll('button')).find(button => button.textContent === 'Fit width')!.click()
  })
  expect(renders).toBe(5)
  expect(cancellations).toBe(4)
  expect(text.children.length).toBe(1)
  expect(text.textContent).toBe('render 5')
  await tree.unmount()
  expect(text.children.length).toBe(0)
})
