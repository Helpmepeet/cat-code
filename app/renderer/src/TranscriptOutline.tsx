import { Component, memo, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { observePaneScroll } from './markdownScrollCoordinator.js'
import { readTranscriptRowOffset } from './transcriptRowNavigation.js'
import { TRANSCRIPT_OUTLINE_MIN_PROMPTS, deriveTranscriptOutline, type TranscriptOutlineEntry } from './transcriptOutlineModel.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'
import { transcriptOutlineBookmarks } from './transcriptOutlineBookmarks.js'
import './transcriptOutline.css'

type Viewport = { first: number; last: number; reading: number }
type OutlineState = {
  previewId: string | null
  tabId: string | null
  viewport: Viewport
}
type OutlineAction =
  | { type: 'preview'; id: string }
  | { type: 'tab'; id: string }
  | { type: 'hide' }
  | { type: 'viewport'; value: Viewport }

function reduceOutline(state: OutlineState, action: OutlineAction): OutlineState {
  switch (action.type) {
    case 'preview': return state.previewId === action.id ? state : { ...state, previewId: action.id }
    case 'tab': return state.tabId === action.id ? state : { ...state, tabId: action.id }
    case 'hide': return state.previewId === null ? state : { ...state, previewId: null }
    case 'viewport': return Object.keys(action.value).every(key =>
      state.viewport[key as keyof Viewport] === action.value[key as keyof Viewport])
      ? state : { ...state, viewport: action.value }
  }
}

// Raw HTML stays off (react-markdown default). The excerpt sits inside the jump
// button, so links and task checkboxes render as text and images never load.
const EXCERPT_PLUGINS = [remarkGfm]
const EXCERPT_COMPONENTS: Components = {
  a: ({ children }) => <span className="transcript-outline-link">{children}</span>,
  img: ({ alt }) => alt ? <span>{alt}</span> : null,
  input: () => null,
}
// The title is one truncated line: blocks keep their words but lose their shape.
const flatten = ({ children }: { children?: ReactNode }) => <>{children}</>
const TITLE_COMPONENTS: Components = {
  ...EXCERPT_COMPONENTS,
  ...Object.fromEntries(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre']
    .map(tag => [tag, flatten])),
  hr: () => null,
}

class ExcerptBoundary extends Component<{ fallback: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}

export const TranscriptOutline = memo(function TranscriptOutline({ rows, scrollerRef, onJump, minPrompts = TRANSCRIPT_OUTLINE_MIN_PROMPTS }: {
  rows: readonly NestedTranscriptRow[]
  scrollerRef: RefObject<HTMLDivElement | null>
  onJump: (entry: TranscriptOutlineEntry) => void
  minPrompts?: number
}) {
  const entries = useMemo(() => deriveTranscriptOutline(rows), [rows])
  const entriesRef = useRef(entries)
  entriesRef.current = entries
  const [state, dispatch] = useReducer(reduceOutline, {
    previewId: null, tabId: null, viewport: { first: -1, last: -1, reading: -1 },
  })
  const bookmarks = useSyncExternalStore(transcriptOutlineBookmarks.subscribe, transcriptOutlineBookmarks.getSnapshot, transcriptOutlineBookmarks.getSnapshot)
  const previewIndex = entries.findIndex(entry => entry.id === state.previewId)
  const preview = entries[previewIndex]
  const tabId = entries.some(entry => entry.id === state.tabId) ? state.tabId : entries[0]?.id
  const rootRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const jumpRef = useRef<HTMLButtonElement>(null)
  const focusPreview = useRef(false)
  const ticksRef = useRef(new Map<string, HTMLButtonElement>())
  const keyboard = useRef(true)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleRef = useRef(() => {})
  const positionRef = useRef(() => {})
  const previewId = useId()

  const clearTimers = () => {
    if (openTimer.current !== null) clearTimeout(openTimer.current)
    if (closeTimer.current !== null) clearTimeout(closeTimer.current)
    openTimer.current = closeTimer.current = null
  }
  const show = (id: string) => { clearTimers(); dispatch({ type: 'preview', id }) }
  const hide = () => { clearTimers(); dispatch({ type: 'hide' }) }
  const hideSoon = () => {
    clearTimers()
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null
      if (!keyboard.current || !rootRef.current?.contains(document.activeElement)) dispatch({ type: 'hide' })
    }, 160)
  }
  const keepTickVisible = (id: string) => {
    const tick = ticksRef.current.get(id)
    const nav = navRef.current
    if (!tick || !nav) return
    if (tick.offsetTop < nav.scrollTop) nav.scrollTop = tick.offsetTop
    else if (tick.offsetTop + tick.offsetHeight > nav.scrollTop + nav.clientHeight) {
      nav.scrollTop = tick.offsetTop + tick.offsetHeight - nav.clientHeight
    }
  }
  const focusTick = (index: number) => {
    const entry = entries[index]
    if (!entry) return
    dispatch({ type: 'tab', id: entry.id })
    ticksRef.current.get(entry.id)?.focus({ preventScroll: true })
    keepTickVisible(entry.id)
  }
  positionRef.current = () => {
    const root = rootRef.current
    const card = cardRef.current
    const tick = preview ? ticksRef.current.get(preview.id) : null
    if (!root || !card || !tick) return
    const box = root.getBoundingClientRect()
    const target = tick.getBoundingClientRect()
    const top = target.top + target.height / 2 - box.top - card.offsetHeight / 2
    card.style.setProperty('--outline-preview-top', `${Math.max(8, Math.min(top, box.height - card.offsetHeight - 8))}px`)
  }
  useLayoutEffect(() => {
    positionRef.current()
    if (focusPreview.current && jumpRef.current) {
      focusPreview.current = false
      jumpRef.current.focus({ preventScroll: true })
    }
  }, [preview?.id, preview?.answer, preview?.prompt])
  useEffect(() => { scheduleRef.current() }, [entries])
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    let frame = 0
    const update = () => {
      if (scroller.clientHeight <= 0) return
      const items = entriesRef.current
      const mounted = new Map<string, HTMLElement>()
      for (const row of scroller.querySelectorAll<HTMLElement>('[data-row-key]')) {
        const key = row.getAttribute('data-row-key')
        if (key !== null) mounted.set(key, row)
      }
      const origin = scroller.getBoundingClientRect().top + scroller.clientTop - scroller.scrollTop
      const offset = (index: number) => {
        const key = items[index]!.rowKey
        const element = mounted.get(key)
        return element ? element.getBoundingClientRect().top - origin : readTranscriptRowOffset(scroller, key)
      }
      // Only logarithmically many virtual offsets are needed, even in a long chat.
      const at = (position: number) => {
        let low = 0, high = items.length - 1, found = -1
        while (low <= high) {
          const middle = (low + high) >> 1
          const top = offset(middle)
          if (top === null) return -1
          if (top <= position) { found = middle; low = middle + 1 }
          else high = middle - 1
        }
        return found
      }
      const first = at(scroller.scrollTop)
      const last = at(scroller.scrollTop + scroller.clientHeight)
      dispatch({ type: 'viewport', value: {
        first: last < 0 ? -1 : Math.max(0, first), last,
        reading: items.length === 0 ? -1 : Math.max(0, at(scroller.scrollTop + 72)),
      } })
      positionRef.current()
    }
    const schedule = () => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => { frame = 0; update() })
    }
    scheduleRef.current = schedule
    const release = observePaneScroll(scroller, update)
    const onKey = () => { keyboard.current = true }
    document.addEventListener('keydown', onKey, true)
    schedule()
    return () => {
      scheduleRef.current = () => {}
      release()
      document.removeEventListener('keydown', onKey, true)
      if (frame !== 0) cancelAnimationFrame(frame)
      clearTimers()
    }
  }, [scrollerRef])
  useEffect(() => {
    if (!preview && entries[state.viewport.reading]) keepTickVisible(entries[state.viewport.reading]!.id)
  }, [state.viewport.reading, preview?.id, entries.length])
  useEffect(() => {
    if (!preview) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) hide()
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [preview?.id])

  if (entries.length === 0 || entries.length < minPrompts) return null
  return <div className="transcript-outline" ref={rootRef} onPointerDownCapture={() => { keyboard.current = false }}
    onKeyDown={event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (cardRef.current?.contains(document.activeElement)) focusTick(previewIndex)
        hide()
      } else if (event.key === 'ArrowLeft' && cardRef.current?.contains(document.activeElement)) {
        event.preventDefault()
        focusTick(previewIndex)
      }
    }}>
    <nav className="transcript-outline-rail" aria-label="Conversation outline" ref={navRef} onScroll={() => positionRef.current()}>
      {entries.map((entry, index) => {
        const distance = preview ? Math.abs(index - previewIndex) : -1
        const bookmarked = bookmarks.has(entry.id)
        return <button key={entry.id} type="button" ref={node => {
          if (node) ticksRef.current.set(entry.id, node)
          else ticksRef.current.delete(entry.id)
        }} className="transcript-outline-tick" tabIndex={entry.id === tabId ? 0 : -1}
          aria-label={`Prompt ${index + 1}${bookmarked ? ', bookmarked' : ''}: ${entry.prompt}`}
          aria-current={index === state.viewport.reading ? 'location' : undefined}
          aria-expanded={distance === 0} aria-controls={distance === 0 ? previewId : undefined}
          data-distance={distance >= 0 && distance <= 3 ? distance : undefined}
          data-in-view={index >= state.viewport.first && index <= state.viewport.last ? '' : undefined}
          data-bookmarked={bookmarked ? '' : undefined}
          onPointerEnter={() => {
            keyboard.current = false
            clearTimers()
            if (preview) show(entry.id)
            else openTimer.current = setTimeout(() => show(entry.id), 90)
          }} onPointerLeave={hideSoon}
          onFocus={() => { dispatch({ type: 'tab', id: entry.id }); show(entry.id) }} onBlur={hideSoon}
          onClick={() => { show(entry.id); onJump(entry) }}
          onKeyDown={event => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              focusTick(Math.max(0, Math.min(entries.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))))
            } else if (event.key === 'Home' || event.key === 'End') {
              event.preventDefault()
              focusTick(event.key === 'Home' ? 0 : entries.length - 1)
            } else if (event.key === 'ArrowRight') {
              event.preventDefault()
              show(entry.id)
              if (jumpRef.current) jumpRef.current.focus({ preventScroll: true })
              else focusPreview.current = true
            }
          }} />
      })}
    </nav>
    {preview ? <div id={previewId} className="transcript-outline-preview" role="group" aria-label="Prompt preview" ref={cardRef}
      onPointerEnter={() => { keyboard.current = false; clearTimers() }} onPointerLeave={hideSoon}
      onFocusCapture={clearTimers} onBlurCapture={hideSoon}>
      <button type="button" className="transcript-outline-jump" ref={jumpRef}
        aria-label={`Jump to prompt ${previewIndex + 1}: ${preview.prompt}`} onClick={() => onJump(preview)}>
        <span className="transcript-outline-prompt">
          <ExcerptBoundary key={preview.prompt} fallback={preview.prompt}>
            <Markdown remarkPlugins={EXCERPT_PLUGINS} components={TITLE_COMPONENTS}>{preview.prompt}</Markdown>
          </ExcerptBoundary>
        </span>
        {preview.answer ? <div className="transcript-outline-answer">
          <ExcerptBoundary key={preview.answer} fallback={preview.answer}>
            <Markdown remarkPlugins={EXCERPT_PLUGINS} components={EXCERPT_COMPONENTS}>{preview.answer}</Markdown>
          </ExcerptBoundary>
        </div> : null}
      </button>
      <button type="button" className="transcript-outline-bookmark"
        aria-pressed={bookmarks.has(preview.id)} aria-label={bookmarks.has(preview.id) ? 'Remove bookmark' : 'Bookmark'}
        onClick={() => transcriptOutlineBookmarks.toggle(preview.id)}>
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 2.5h8v11l-4-2.8-4 2.8z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
      </button>
    </div> : null}
  </div>
})
