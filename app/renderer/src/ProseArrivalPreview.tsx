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
import {
  PROSE_PREVIEW_CHUNK_MS,
  PROSE_PREVIEW_START_TICK,
  nextPreviewTick,
  prosePreviewFrame,
} from './proseArrivalPreviewModel.js'


export function ProseArrivalPreview() {
  const { arrival } = useContext(ProseArrivalContext)
  const [tick, setTick] = useState(PROSE_PREVIEW_START_TICK)

  // The component owns only the clock. Everything the frame shows is derived
  // from `tick` by `prosePreviewFrame`, which is enumerable in a test without
  // timers; an earlier version kept the step in this effect's closure AND in its
  // dependency list, so every advance reset it and the sample never progressed.
  useEffect(() => {
    const timer = setInterval(
      () => setTick(prev => nextPreviewTick(prev)),
      PROSE_PREVIEW_CHUNK_MS,
    )
    return () => clearInterval(timer)
  }, [arrival])

  const { source, priorLength } = prosePreviewFrame(tick)
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
    <div className="h-[152px] overflow-hidden rounded-lg border border-shell-seam bg-app-bg px-4 py-3">
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
