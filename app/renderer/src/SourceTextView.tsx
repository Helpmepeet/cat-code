import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { describeOutputSearch, selectOutputLineChunk, stepMatchIndex } from './outputSearchModel.js'
import { selectHighlightedSourceRows } from './sourceHighlight.js'
import { selectRowWordSegments, type DiffRow } from './diffRowModel.js'
import { highlightedWordSegments } from './diffHighlight.js'
import { DIFF_ROW_CLASS, DIFF_SIGN_CLASS, WORD_DIM_CLASS, WORD_EMPH_CLASS } from './toolCardPalette.js'
import { ActionCheckIcon, ActionCopyIcon } from './SessionActionIcons.js'
import { useToast } from './toastContext.js'
import { VirtualLineList } from './VirtualLineList.js'
import { MAX_MOUNTED_CHUNK_CHARS, selectVisualChunk } from './lineWindow.js'
import './toolOutputPanel.css'

/**
 * Literal classes only, and on the SCROLL BOX rather than on each row:
 * `VirtualLineList` folds its container's class list into the layout revision
 * that qualifies every measured row height, and a wrap toggle changes every one
 * of those heights without changing a character of text. Toggling Wrap
 * therefore invalidates the measurements taken under the old mode instead of
 * leaving stale ones behind rows that no longer match them.
 */
const LINE_TEXT_CLASS = {
  wrap: 'tool-output-scroller is-wrapped',
  nowrap: 'tool-output-scroller',
} as const

const MATCH_CLASS = 'rounded-sm bg-tone-warn/25 px-px text-[light-dark(#834a00,#fde68a)]'

/**
 * The toolbar and the body it acts on. Search state belongs to one body, so a
 * different file or view starts a fresh search.
 */
export function SourceTextView({
  lines,
  body,
  copy,
  gutter,
  language,
  diffRows,
  wrap,
  onWrap,
  subject = 'output',
  lineTarget,
  onScroll,
  initialTopLine,
  initialScrollLeft,
  scrollerRef,
  toolbarActions,
}: {
  lines: readonly string[]
  body: string
  copy: string
  gutter: (index: number) => ReactNode
  language: string | null
  diffRows: readonly DiffRow[] | null
  wrap: boolean
  onWrap: (wrap: boolean) => void
  subject?: 'output' | 'file'
  toolbarActions?: ReactNode
  lineTarget?: { line: number; token: number }
  initialTopLine?: number
  initialScrollLeft?: number
  onScroll?: (position: { x: number; y: number; topLine: number }) => void
  scrollerRef?: React.RefObject<HTMLDivElement | null>
}) {
  const [query, setQuery] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const [chunks, setChunks] = useState<ReadonlyMap<number, number>>(() => new Map())
  const [matchIndex, setMatchIndex] = useState(0)
  const [copied, setCopied] = useState(false)
  const toast = useToast()
  useEffect(() => { setQuery(''); setMatchIndex(0) }, [lineTarget?.token])
  const search = useMemo(
    () => describeOutputSearch(body, query, matchIndex),
    [body, query, matchIndex],
  )
  // Memoized apart from the search, which re-runs on every keystroke while
  // this depends only on the body. Null past the highlighter's ceilings, and
  // for text that is not a file's source.
  const coloured = useMemo(
    () => selectHighlightedSourceRows(lines, language),
    [lines, language],
  )
  const matchCount = search.matchCount
  const step = (delta: number): void => {
    setMatchIndex(index => stepMatchIndex(index, delta, matchCount))
  }

  const copyLabel = subject === 'file' ? copied ? 'File copied' : 'Copy file' : copied ? 'Output copied' : 'Copy output'
  const copyOutput = (): void => {
    const clipboard =
      typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    if (!clipboard) return
    void clipboard
      .writeText(copy)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
        toast(subject === 'file' ? 'Copied file' : 'Copied output', { tone: 'success' })
      })
      .catch(() => {})
  }

  return (
    <div className="source-text-view" ref={root} onKeyDown={event => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        const input = root.current?.querySelector<HTMLInputElement>('input[data-output-search]')
        input?.focus()
        input?.select()
      }
    }}>
      <div className="tool-output-toolbar">
        <label className="tool-output-search">
          <SearchIcon />
          <input
            type="text"
            data-output-search=""
            aria-label={subject === 'file' ? 'Search file' : 'Search output'}
            placeholder="Search"
            value={query}
            spellCheck={false}
            onChange={event => {
              setQuery(event.target.value)
              setMatchIndex(0)
            }}
            onKeyDown={event => {
              if (event.key === 'Enter' && matchCount > 0) {
                event.preventDefault()
                step(event.shiftKey ? -1 : 1)
              } else if (event.key === 'Escape' && query.length > 0) {
                // The first Escape clears the search; the next one closes.
                event.preventDefault()
                setQuery('')
                setMatchIndex(0)
              }
            }}
          />
          {search.searching ? (
            <>
              <span className="tool-output-count" title={search.label}>{search.label}</span>
              <button
                type="button"
                className="tool-output-step"
                onClick={() => step(-1)}
                disabled={matchCount === 0}
                aria-label="Previous match"
              >
                <ChevronGlyph direction="up" />
              </button>
              <button
                type="button"
                className="tool-output-step"
                onClick={() => step(1)}
                disabled={matchCount === 0}
                aria-label="Next match"
              >
                <ChevronGlyph direction="down" />
              </button>
            </>
          ) : null}
        </label>
        {toolbarActions}
        <button
          type="button"
          className="tool-output-tool"
          onClick={() => onWrap(!wrap)}
          aria-pressed={wrap}
        >
          Wrap
        </button>
        <button
          type="button"
          className="tool-output-tool"
          data-copied={copied ? '' : undefined}
          onClick={copyOutput}
          aria-label={copyLabel}
          title={copyLabel}
        >
          {copied ? <ActionCheckIcon /> : <ActionCopyIcon />}
          <span className="source-text-copy-label">{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <VirtualLineList
        lines={search.lines}
        activeIndex={search.activeLine === null ? lineTarget ? lineTarget.line - 1 : null : search.activeLine - 1}
        activeRequest={search.searching ? search.activeIndex : lineTarget?.token}
        align={search.searching ? 'center' : 'start'}
        initialTopLine={initialTopLine}
        initialScrollLeft={initialScrollLeft}
        onPosition={onScroll}
        scrollerRef={scrollerRef}
        className={wrap ? LINE_TEXT_CLASS.wrap : LINE_TEXT_CLASS.nowrap}
        label={subject === 'file' ? 'File contents' : 'Output'}
        renderLine={(bounded, index) => {
          const position = index + 1
          const active = search.searching ? search.activeLine === position : lineTarget?.line === position
          const diffRow = diffRows?.[index]
          let content: ReactNode
          let themed = diffRow !== undefined
          if (search.searching) {
            // The list hands over a chunk cut from the start of the line. This
            // body holds the full line, so it re-cuts around the active match
            // instead: a match a megabyte into one logical line has to be
            // reachable, and only the search model knows where it is.
            const chunk = selectOutputLineChunk(search.lines[index] ?? '', query, {
              anchorOffset: active ? search.activeOffset ?? undefined : undefined,
            })
            content = (
              <>
                {chunk.truncatedStart ? '…' : null}
                {chunk.segments.map((segment, segmentIndex) =>
                  segment.match ? (
                    <mark key={segmentIndex} className={MATCH_CLASS}>{segment.text}</mark>
                  ) : (
                    <span key={segmentIndex}>{segment.text}</span>
                  ),
                )}
                {chunk.truncatedEnd ? '…' : null}
              </>
            )
          } else {
            const colour = coloured?.[index]
            themed = themed || colour !== undefined
            const chunkOffset = chunks.get(index) ?? 0
            const raw = lines[index] ?? ''
            const chunk = selectVisualChunk(raw, chunkOffset === 0 ? 0 : chunkOffset + MAX_MOUNTED_CHUNK_CHARS / 2)
            const long = raw.length > MAX_MOUNTED_CHUNK_CHARS
            content = long ? <>
              {chunk.truncatedStart ? <button className="source-chunk-control" aria-label={`Previous part of line ${position}`} onClick={() => setChunks(previous => new Map(previous).set(index, Math.max(0, chunkOffset - MAX_MOUNTED_CHUNK_CHARS)))}>‹…</button> : null}
              {chunk.text}
              {chunk.truncatedEnd ? <button className="source-chunk-control" aria-label={`Next part of line ${position}`} onClick={() => setChunks(previous => new Map(previous).set(index, chunkOffset + MAX_MOUNTED_CHUNK_CHARS))}>…›</button> : null}
            </> : colour ?? bounded
            const segments = diffRows === null ? null : selectRowWordSegments(diffRows, index)
            if (diffRow !== undefined && segments !== null) {
              const side = diffRow.kind === 'del' ? 'del' : 'add'
              content = highlightedWordSegments([content], segments, WORD_EMPH_CLASS[side], WORD_DIM_CLASS[side])
            }
          }
          return (
            <div
              className={`tool-output-row${diffRow ? ` ${DIFF_ROW_CLASS[diffRow.kind]}` : ''}${active ? ' is-active' : ''}`}
            >
              <span className="tool-output-gutter">{gutter(index)}</span>
              {diffRow ? (
                <span className={`tool-output-sign ${DIFF_SIGN_CLASS[diffRow.kind]}`}>
                  {diffRow.kind === 'add' ? '+' : diffRow.kind === 'del' ? '−' : ' '}
                </span>
              ) : null}
              <span className={themed ? 'tool-output-code hljs' : 'tool-output-code'}>{content}</span>
            </div>
          )
        }}
      />
    </div>
  )
}

function SearchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.25" strokeLinecap="round" aria-hidden>
      <circle cx="11" cy="11" r="7.5" />
      <line x1="20.5" y1="20.5" x2="16.4" y2="16.4" />
    </svg>
  )
}

function ChevronGlyph({ direction }: { direction: 'up' | 'down' }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points={direction === 'up' ? '6 15 12 9 18 15' : '6 9 12 15 18 9'} />
    </svg>
  )
}
