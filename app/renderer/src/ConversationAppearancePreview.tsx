import { useContext, useEffect, useState } from 'react'
import type { Root as HastRoot } from 'hast'
import { FocusedReasoning, TranscriptRowsView } from './TranscriptView.js'
import { BoundedMarkdown } from './BoundedMarkdown.js'
import { renderMarkdownTree } from './markdownRenderPlan.js'
import { MAX_PROSE_ARRIVAL_STAGGER_MS, PROSE_ARRIVAL_WORD_CLASS, PROSE_ARRIVAL_WORD_STAGGER_MS, ProseArrivalContext } from './proseArrival.js'
import { markArrivedText } from './proseArrivalMark.js'
import { PROSE_PREVIEW_CHUNKS, PROSE_PREVIEW_CHUNK_MS, prosePreviewFrame } from './proseArrivalPreviewModel.js'
import { ToolsExpandedContext } from './toolsExpanded.js'
import { APPEARANCE_PREVIEW_CODE, APPEARANCE_PREVIEW_ROWS, APPEARANCE_PREVIEW_USER_ROWS, APPEARANCE_PREVIEW_FOCUSED_TURN } from './appearancePreviewModel.js'
import { CodeThemePreview } from './CodeThemePreview.js'
import { TranscriptModeContext } from './transcriptMode.js'
import { FocusedTranscript } from './FocusedTranscript.js'

const FULL_TRANSCRIPT_CONTEXT = { mode: 'full' as const, setMode: () => {} }

const COMPLETE_REPLY = PROSE_PREVIEW_CHUNKS.join('')

// Use the real transcript rows and the same markdown/arrival path as assistant
// prose. A hand-drawn settings sample would silently diverge from the chat.
export function ConversationAppearancePreview({ replay }: { replay: number }) {
  const { arrival } = useContext(ProseArrivalContext)
  const { expanded } = useContext(ToolsExpandedContext)
  const { mode } = useContext(TranscriptModeContext)
  return (
    <div aria-label="Conversation preview" className="appearance-preview" data-window-card role="region">
      {mode === 'full' ? <TranscriptRowsView key={String(expanded)} rows={APPEARANCE_PREVIEW_ROWS} /> : (
        <TranscriptModeContext.Provider value={FULL_TRANSCRIPT_CONTEXT}>
          <TranscriptRowsView rows={APPEARANCE_PREVIEW_USER_ROWS} />
          <div className="appearance-preview-focused">
            <FocusedTranscript turn={APPEARANCE_PREVIEW_FOCUSED_TURN} renderRows={rows => (
              <TranscriptRowsView key={String(expanded)} rows={[...rows]} />
            )} renderReasoning={(rows, live) => <FocusedReasoning rows={rows} live={live} />} />
          </div>
        </TranscriptModeContext.Provider>
      )}
      <div className="appearance-preview-reply">
        <ArrivingReply key={`${arrival}:${replay}`} play={replay > 0} />
        <div className="md-prose"><CodeThemePreview code={APPEARANCE_PREVIEW_CODE} language="typescript" /></div>
      </div>
    </div>
  )
}

function ArrivingReply({ play }: { play: boolean }) {
  const { arrival } = useContext(ProseArrivalContext)
  const [tick, setTick] = useState(play ? 0 : PROSE_PREVIEW_CHUNKS.length + 1)
  useEffect(() => {
    if (!play || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setTick(PROSE_PREVIEW_CHUNKS.length + 1)
      return
    }
    let delivered = 0
    const timer = setInterval(() => {
      delivered += 1
      setTick(delivered)
      if (delivered > PROSE_PREVIEW_CHUNKS.length) clearInterval(timer)
    }, PROSE_PREVIEW_CHUNK_MS)
    return () => clearInterval(timer)
  }, [play])
  const { source, priorLength } = prosePreviewFrame(tick)
  const className = PROSE_ARRIVAL_WORD_CLASS[arrival]
  const mark = (tree: HastRoot) => className === null || priorLength < 0 ? tree : markArrivedText(tree, {
    fromOffset: priorLength,
    className,
    staggerMs: PROSE_ARRIVAL_WORD_STAGGER_MS[arrival],
    maxStaggerMs: MAX_PROSE_ARRIVAL_STAGGER_MS,
  })
  return (
    <div className="appearance-arrival font-sans font-medium text-sm leading-relaxed">
      <div aria-hidden className="appearance-arrival-measure">{COMPLETE_REPLY}</div>
      <div className="md-prose"><BoundedMarkdown sourceId="appearance-preview-reply" source={source} renderLeaf={leaf => renderMarkdownTree(mark(leaf.tree))} /></div>
    </div>
  )
}
