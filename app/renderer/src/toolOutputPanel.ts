/**
 * The docked full-output panel's shared state: how a tool card asks for it, and
 * the width the operator last dragged it to.
 *
 * The panel lives in `SubagentWorkspace`'s right-hand slot, beside the
 * transcript, which is the slot the worker panel already uses. Every transcript
 * inside that workspace (the parent pane, and a worker's own steps in the side
 * panel) reaches it through this one context, so a second `Open full output`
 * swaps what the panel shows instead of stacking another surface.
 *
 * A card's truncation reveal band is the only route in. The always-present
 * `Inspector` card footer was removed 2026-08-13
 * (`docs/reports/2026-08-12-tool-inspector-ux-review.md`), so the panel is
 * reached only for output a card had to cut.
 *
 * A `.ts` module because a production `.tsx` may export components only (the
 * Fast Refresh boundary).
 */

import { createContext } from 'react'
import type { NestedToolUseRow } from './transcriptProjector.js'
import {
  defaultViewPreferenceStorage,
  readViewPreference,
  writeViewPreference,
  type ViewPreferenceStorage,
} from './viewPreference.js'

export type OpenToolOutput = (row: NestedToolUseRow, fileIndex?: number) => void

/**
 * Null outside a workspace (a card rendered alone, a style preview), where the
 * reveal band simply omits its button. The provided value is a stable callback,
 * so publishing it never defeats the memoized row subtree.
 */
export const ToolOutputContext = createContext<OpenToolOutput | null>(null)

export const TOOL_OUTPUT_WIDTH_STORAGE_KEY = 'catcode.toolOutputPanelWidth.v1'
export const TOOL_OUTPUT_DEFAULT_WIDTH = 560
export const TOOL_OUTPUT_MIN_WIDTH = 360
/**
 * What a dragged panel must leave the transcript beside it. The stylesheet
 * enforces the same floor with `max-width`, which is what keeps a remembered
 * wide panel from crowding out a window that has since been made smaller.
 */
export const TOOL_OUTPUT_TRANSCRIPT_RESERVE = 440
/** One arrow-key step on the resize handle. */
export const TOOL_OUTPUT_WIDTH_STEP = 32
/** A stored width past this is not one a drag produced. */
const TOOL_OUTPUT_STORED_MAX = 4_000

export function clampToolOutputWidth(width: number, layoutWidth: number | null): number {
  const max = layoutWidth === null
    ? TOOL_OUTPUT_STORED_MAX
    : Math.max(TOOL_OUTPUT_MIN_WIDTH, layoutWidth - TOOL_OUTPUT_TRANSCRIPT_RESERVE)
  return Math.round(Math.min(Math.max(width, TOOL_OUTPUT_MIN_WIDTH), max))
}

export function readToolOutputWidth(
  storage: ViewPreferenceStorage | null = defaultViewPreferenceStorage(),
): number {
  return readViewPreference(storage, TOOL_OUTPUT_WIDTH_STORAGE_KEY, 'width', value =>
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= TOOL_OUTPUT_MIN_WIDTH &&
    value <= TOOL_OUTPUT_STORED_MAX
      ? Math.round(value)
      : null,
  ) ?? TOOL_OUTPUT_DEFAULT_WIDTH
}

export function writeToolOutputWidth(
  width: number,
  storage: ViewPreferenceStorage | null = defaultViewPreferenceStorage(),
): void {
  writeViewPreference(storage, TOOL_OUTPUT_WIDTH_STORAGE_KEY, 'width', Math.round(width))
}
