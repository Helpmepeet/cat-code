import { useEffect, useRef, useState, type RefObject } from 'react'
import type { TextLayer, PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { FilePreviewDescriptor } from '../../shared/filePreview.js'
import './pdfDocument.css'

export type PdfDocumentPosition = { page: number; zoom: number; fitWidth: boolean }
const DEFAULT_POSITION: PdfDocumentPosition = { page: 1, zoom: 1, fitWidth: true }
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3]
const MAX_PAGE_PIXELS = 12_000_000
const MAX_PAGE_EDGE = 8192

export function PdfDocumentView({ file, active, className = '', bodyRef, initialPosition, onPosition, onReady, onFailure, onExternal }: {
  file: FilePreviewDescriptor
  active: boolean
  className?: string
  bodyRef?: RefObject<HTMLDivElement | null>
  initialPosition?: PdfDocumentPosition
  onPosition?: (position: PdfDocumentPosition) => void
  onReady?: () => void
  onFailure?: () => void
  onExternal?: () => void
}) {
  const initial = useRef(initialPosition ?? DEFAULT_POSITION)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [locked, setLocked] = useState(false)
  const [page, setPage] = useState(Math.max(1, Math.floor(initial.current.page) || 1))
  const [draft, setDraft] = useState(String(page))
  const [zoom, setZoom] = useState(ZOOMS.includes(initial.current.zoom) ? initial.current.zoom : 1)
  const [fitWidth, setFitWidth] = useState(initial.current.fitWidth)
  const [width, setWidth] = useState(0)
  const [pageError, setPageError] = useState(false)
  const [limited, setLimited] = useState(false)
  const viewportRef = useRef<HTMLDivElement>(null)
  const callbacks = useRef({ onReady, onFailure, onPosition })
  callbacks.current = { onReady, onFailure, onPosition }
  const ready = useRef(false)
  const loading = useRef<PDFDocumentLoadingTask | null>(null)

  useEffect(() => {
    let current = true
    ready.current = false
    setPdf(null)
    setLocked(false)
    const fail = () => { if (current) callbacks.current.onFailure?.() }
    void window.catcode.readFilePreviewDocument(file.id, file.revision, { kind: 'pdf' }).then(async result => {
      if (!current) return
      if (!result.ok || result.kind !== 'pdf') { fail(); return }
      const { openPdfDocument } = await import('./pdfDocumentRuntime.js')
      if (!current) return
      const task = openPdfDocument(result.bytes)
      loading.current = task
      let encrypted = false
      task.onPassword = () => {
        encrypted = true
        if (current) setLocked(true)
        void task.destroy()
      }
      try {
        const document = await task.promise
        if (!current) { await task.destroy(); return }
        setPage(value => Math.min(document.numPages, value))
        setPdf(document)
      } catch {
        if (!encrypted) fail()
      }
    }).catch(fail)
    return () => {
      current = false
      const task = loading.current
      loading.current = null
      void task?.destroy().catch(() => {})
    }
  }, [file.id, file.revision])

  useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const update = () => { if (element.clientWidth > 0) setWidth(Math.max(1, element.clientWidth - 32)) }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [locked])

  useEffect(() => { setDraft(String(page)) }, [page])
  useEffect(() => {
    callbacks.current.onPosition?.({ page, zoom, fitWidth })
  }, [page, zoom, fitWidth, active])
  useEffect(() => {
    if (!locked) return
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => {
      if (!ready.current) { ready.current = true; callbacks.current.onReady?.() }
    }) })
    return () => cancelAnimationFrame(frame)
  }, [locked])

  const pageReady = () => {
    setPageError(false)
    if (!ready.current) { ready.current = true; callbacks.current.onReady?.() }
  }
  const pageFailed = () => {
    if (!ready.current) callbacks.current.onFailure?.()
    else setPageError(true)
  }
  const choosePage = (value: number) => {
    if (!pdf || !Number.isFinite(value)) { setDraft(String(page)); return }
    setPage(Math.max(1, Math.min(pdf.numPages, Math.floor(value))))
    setPageError(false)
    if (viewportRef.current) viewportRef.current.scrollTop = 0
  }
  const commitDraft = () => { choosePage(Number(draft)); setDraft(String(Math.max(1, Math.min(pdf?.numPages ?? 1, Math.floor(Number(draft)) || page)))) }
  const neighbour = pdf && pdf.numPages > 1 ? page < pdf.numPages ? page + 1 : page - 1 : null
  return <div className={`pdf-document-view ${className}`}>
    {locked ? <div className="pdf-document-locked" role="status">
      <p>This PDF needs a password.</p>
      {onExternal ? <button type="button" className="file-pane-note-action" onClick={onExternal}>Open externally</button> : null}
    </div> : <>
      <div className="pdf-document-toolbar">
        <button type="button" aria-label="Previous page" title="Previous page" disabled={!pdf || page <= 1} onClick={() => choosePage(page - 1)}>‹</button>
        <input type="number" aria-label="Page number" min={1} max={pdf?.numPages ?? 1} value={draft} disabled={!pdf}
          onChange={event => setDraft(event.target.value)} onBlur={commitDraft}
          onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); commitDraft() } }} />
        <span className="pdf-document-page-count">/ {pdf?.numPages ?? '…'}</span>
        <button type="button" aria-label="Next page" title="Next page" disabled={!pdf || page >= pdf.numPages} onClick={() => choosePage(page + 1)}>›</button>
        <button type="button" aria-pressed={fitWidth} disabled={!pdf} onClick={() => setFitWidth(true)}>Fit width</button>
        <select aria-label="Zoom" value={zoom} disabled={!pdf} onChange={event => { setZoom(Number(event.target.value)); setFitWidth(false) }}>
          {ZOOMS.map(value => <option key={value} value={value}>{value * 100}%</option>)}
        </select>
        {limited ? <span className="pdf-document-zoom-limit" role="status" title="Zoom is limited for this page." aria-label="Zoom is limited for this page.">Limited</span> : null}
      </div>
      {pageError ? <div className="file-pane-note" role="status"><span>Could not show this page.</span>{onExternal ? <button type="button" className="file-pane-note-action" onClick={onExternal}>Open externally</button> : null}</div> : null}
      <div className="pdf-document-pages" ref={element => { viewportRef.current = element; if (bodyRef) bodyRef.current = element }} tabIndex={active ? 0 : -1} aria-label="PDF">
        {pdf && width > 0 ? <>
          <PdfPage key={`${file.id}:${page}`} pdf={pdf} number={page} width={width} zoom={zoom} fitWidth={fitWidth} onReady={pageReady} onFailure={pageFailed} onLimited={setLimited} />
          {neighbour ? <PdfPage key={`${file.id}:${neighbour}`} pdf={pdf} number={neighbour} width={width} zoom={zoom} fitWidth={fitWidth} hidden /> : null}
        </> : null}
      </div>
    </>}
  </div>
}

function PdfPage({ pdf, number, width, zoom, fitWidth, hidden = false, onReady, onFailure, onLimited }: {
  pdf: PDFDocumentProxy
  number: number
  width: number
  zoom: number
  fitWidth: boolean
  hidden?: boolean
  onReady?: () => void
  onFailure?: () => void
  onLimited?: (limited: boolean) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const text = useRef<HTMLDivElement>(null)
  const renderGeneration = useRef(0)
  const lifecycle = useRef<Promise<void>>(Promise.resolve())
  const status = useRef<'pending' | 'ready' | 'failed'>('pending')
  const wasLimited = useRef(false)
  const callbacks = useRef({ onReady, onFailure, onLimited })
  callbacks.current = { onReady, onFailure, onLimited }
  useEffect(() => {
    if (hidden) return
    if (status.current === 'ready') callbacks.current.onReady?.()
    else if (status.current === 'failed') callbacks.current.onFailure?.()
    callbacks.current.onLimited?.(wasLimited.current)
  }, [hidden])
  useEffect(() => {
    let current = true
    status.current = 'pending'
    const generation = ++renderGeneration.current
    const prior = lifecycle.current
    let finish: (() => void) | undefined
    lifecycle.current = new Promise<void>(resolve => { finish = resolve })
    let page: PDFPageProxy | null = null
    let render: RenderTask | null = null
    let layer: TextLayer | null = null
    const canvasElement = canvas.current
    const textElement = text.current
    const rootElement = root.current
    if (!canvasElement || !textElement || !rootElement) { finish?.(); return }
    void (async () => {
      await prior
      if (!current) return
      const { TextLayer } = await import('./pdfDocumentRuntime.js')
      if (!current) return
      page = await pdf.getPage(number)
      if (!current) { page.cleanup(); return }
      const natural = page.getViewport({ scale: 1 })
      const desired = fitWidth ? width / natural.width : zoom
      const scale = Math.min(desired, MAX_PAGE_EDGE / natural.width, MAX_PAGE_EDGE / natural.height, Math.sqrt(MAX_PAGE_PIXELS / (natural.width * natural.height)))
      const viewport = page.getViewport({ scale })
      wasLimited.current = scale < desired
      callbacks.current.onLimited?.(wasLimited.current)
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(MAX_PAGE_PIXELS / (viewport.width * viewport.height)))
      canvasElement.width = Math.max(1, Math.floor(viewport.width * pixelRatio))
      canvasElement.height = Math.max(1, Math.floor(viewport.height * pixelRatio))
      rootElement.style.setProperty('--pdf-page-width', `${viewport.width}px`)
      rootElement.style.setProperty('--pdf-page-height', `${viewport.height}px`)
      rootElement.style.setProperty('--total-scale-factor', String(scale * page.userUnit))
      const context = canvasElement.getContext('2d')
      if (!context) throw new Error('Canvas unavailable')
      render = page.render({ canvas: canvasElement, canvasContext: context, viewport, transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0] })
      await render.promise
      if (!current) return
      layer = new TextLayer({ textContentSource: page.streamTextContent(), container: textElement, viewport })
      await layer.render()
      if (current) { status.current = 'ready'; callbacks.current.onReady?.() }
    })().catch(error => {
      if (current && error?.name !== 'RenderingCancelledException') { status.current = 'failed'; callbacks.current.onFailure?.() }
    }).finally(() => finish?.())
    return () => {
      current = false
      render?.cancel()
      layer?.cancel()
      // TextLayer.cancel stops work but leaves its nodes in the shared container.
      // Clear them before the next generation starts, not in the deferred release.
      textElement.replaceChildren()
      const release = () => {
        if (renderGeneration.current === generation) {
          canvasElement.width = 0
          canvasElement.height = 0
        }
        page?.cleanup()
      }
      if (render) void render.promise.catch(() => {}).then(release)
      else release()
    }
  }, [pdf, number, width, zoom, fitWidth])
  return <div ref={root} className="pdf-document-page" hidden={hidden} aria-label={`Page ${number}`}>
    <canvas ref={canvas} aria-hidden="true" />
    <div ref={text} className="pdf-document-text textLayer" />
  </div>
}
