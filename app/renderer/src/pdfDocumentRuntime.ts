import { getDocument, GlobalWorkerOptions, TextLayer } from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

// PDF.js requests these resources by their original names. Vite emits hashed,
// local assets; factories retain the name mapping without any remote fallback.
const cMaps = import.meta.glob<string>('../../node_modules/pdfjs-dist/cmaps/*.bcmap', { eager: true, query: '?url&no-inline', import: 'default' })
const fonts = import.meta.glob<string>('../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}', { eager: true, query: '?url&no-inline', import: 'default' })
const resourceNames = (resources: Record<string, string>) => new Map(Object.entries(resources).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url]))
const cMapUrls = resourceNames(cMaps)
const fontUrls = resourceNames(fonts)
async function resourceBytes(url: string | undefined): Promise<Uint8Array> {
  if (!url) throw new Error('PDF font unavailable')
  const response = await fetch(url)
  if (!response.ok) throw new Error('PDF font unavailable')
  return new Uint8Array(await response.arrayBuffer())
}
class BundledBinaryDataReader {
  fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const resources = kind === 'cMapUrl' ? cMapUrls : kind === 'standardFontDataUrl' ? fontUrls : null
    return resourceBytes(resources?.get(filename))
  }
}

export { TextLayer }

export function openPdfDocument(bytes: Uint8Array) {
  return getDocument({
    data: bytes,
    useWasm: false,
    useSystemFonts: true,
    isOffscreenCanvasSupported: false,
    useWorkerFetch: false,
    BinaryDataFactory: BundledBinaryDataReader,
    maxImageSize: 12_000_000,
    canvasMaxAreaInBytes: 12_000_000 * 4,
  })
}
