/**
 * The live canvas above the "Text arrival" picker in Settings ▸ Transcript.
 *
 * IT MUST PLAY. The three options are identical once text has settled — they
 * differ only in how it got there — so a still image of any of them is the same
 * picture and tells the operator nothing. This replays a short delivery on a
 * loop and re-renders through the SAME `BoundedMarkdown` + `markArrivedText`
 * path the transcript uses, so what is previewed is the mechanism rather than an
 * imitation of it (the rule `CodeThemePreview` states for the code block).
 *
 * It follows the CURRENT selection from context rather than taking a prop, so
 * changing the picker restyles it with no wiring, exactly as the code-theme and
 * tool-card previews do.
 *
 * FIXED HEIGHT. The sample grows while it plays; a canvas sized to its content
 * would pump the settings rows below it up and down on every loop.
 */

import { useContext, useEffect, useState } from 'react'
import type { Root as HastRoot } from 'hast'
import { BoundedMarkdown } from './BoundedMarkdown.js'
import { renderMarkdownTree } from './markdownRenderPlan.js'
import {
  MAX_PROSE_ARRIVAL_STAGGER_MS,
  PROSE_ARRIVAL_WORD_CLASS,
  PROSE_ARRIVAL_WORD_STAGGER_MS,
  ProseArrivalContext,
} from './proseArrival.js'
import { markArrivedText } from './proseArrivalMark.js'

/** Delivered in chunks that are not word-aligned, because real ones are not. */
const PREVIEW_CHUNKS = [
  'The loader resolves each entry ',
  'twice: once to build the depend',
  'ency list, and once when that l',
  'ist is consumed.',
]

const CHUNK_MS = 420
const HOLD_MS = 1400

export function ProseArrivalPreview() {
  const { arrival } = useContext(ProseArrivalContext)
  // Starts settled so the server render and the first paint show real text
  // rather than an empty box.
  const [delivered, setDelivered] = useState(PREVIEW_CHUNKS.length)
  const [priorLength, setPriorLength] = useState(-1)

  useEffect(() => {
    let step = 0
    const advance = (): void => {
      step += 1
      const atEnd = step > PREVIEW_CHUNKS.length
      if (atEnd) {
        step = 0
        setDelivered(0)
        setPriorLength(-1)
        return
      }
      setPriorLength(
        PREVIEW_CHUNKS.slice(0, step - 1).join('').length,
      )
      setDelivered(step)
    }
    const timer = setInterval(
      advance,
      delivered >= PREVIEW_CHUNKS.length ? HOLD_MS : CHUNK_MS,
    )
    return () => clearInterval(timer)
  }, [arrival, delivered])

  const source = PREVIEW_CHUNKS.slice(0, delivered).join('')
  const className = PROSE_ARRIVAL_WORD_CLASS[arrival]

  const mark = (tree: HastRoot): HastRoot => {
    if (className === null || priorLength < 0) return tree
    return markArrivedText(tree, {
      fromOffset: priorLength,
      className,
      staggerMs: PROSE_ARRIVAL_WORD_STAGGER_MS[arrival],
      maxStaggerMs: MAX_PROSE_ARRIVAL_STAGGER_MS,
    })
  }

  return (
    <div className="h-[92px] overflow-hidden rounded-lg border border-shell-seam bg-app-bg px-4 py-3">
      {/* Keyed by option so switching restarts the delivery instead of showing
          the new timing only from the next chunk onward. */}
      <div className="md-prose font-sans font-medium text-sm leading-relaxed" key={arrival}>
        <BoundedMarkdown
          sourceId={`prose-arrival-preview:${arrival}`}
          source={source}
          renderLeaf={leaf => renderMarkdownTree(mark(leaf.tree))}
        />
      </div>
    </div>
  )
}
