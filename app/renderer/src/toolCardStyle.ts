/**
 * How a tool call is drawn in the transcript — a RENDERER-LOCAL view preference.
 *
 * Two styles, and `lines` is not a new visual language: the transcript already
 * draws a tool call that way. A member inside a read run renders as a bare row
 * whose open body is an indented rule (`ToolRunRow`, `TranscriptView.tsx`), with
 * no container of its own. This preference applies that existing treatment to
 * top-level calls, so picking `lines` moves the transcript onto one grammar
 * instead of introducing a second.
 *
 * NOT an engine setting. Nothing in `app/shared/settingsEditable.ts` decides how
 * a transcript row is drawn, so this persists exactly like `toolsExpanded`, the
 * reasoning layout and the code theme: versioned JSON in the renderer's own
 * storage, best-effort.
 *
 * Orthogonal to `toolsExpanded`, which decides WHETHER a card is open. This
 * decides how the card is drawn once it is. Both apply in either style.
 *
 * Class strings are whole and static, never interpolated: Tailwind resolves
 * classes at build time from literal source text, so a composed
 * `border-${x}` silently produces no rule at all.
 */

import { createContext } from 'react'

export const TOOL_CARD_STYLE_STORAGE_KEY = 'catcode.toolCardStyle.v1'

export const TOOL_CARD_STYLES = ['cards', 'lines'] as const

export type ToolCardStyle = (typeof TOOL_CARD_STYLES)[number]

/** Today's drawing, so an existing transcript is unchanged until asked. */
export const DEFAULT_TOOL_CARD_STYLE: ToolCardStyle = 'cards'

export const TOOL_CARD_STYLE_LABELS: Record<ToolCardStyle, string> = {
  cards: 'Cards',
  lines: 'Lines',
}

export function isToolCardStyle(value: string): value is ToolCardStyle {
  return (TOOL_CARD_STYLES as readonly string[]).includes(value)
}

/** The card's outer container. `lines` keeps the width and drops the chrome. */
export const TOOL_CARD_SHELL_CLASS: Record<ToolCardStyle, string> = {
  cards:
    'w-full overflow-hidden rounded-md border border-shell-seam bg-white/[0.025] font-sans',
  lines: 'w-full font-sans',
}

/** The clickable header row. Side padding belongs to the container it no
 * longer has, so `lines` drops it and keeps the row on the transcript's
 * own left edge. */
export const TOOL_CARD_HEADER_CLASS: Record<ToolCardStyle, string> = {
  cards: 'group flex w-full items-center gap-2.5 px-3 py-2 text-left',
  lines: 'group flex w-full items-center gap-2.5 py-0.5 text-left',
}

/** The header of a shell whose own markup omits the `group` hover contract. */
export const TOOL_CARD_PLAIN_HEADER_CLASS: Record<ToolCardStyle, string> = {
  cards: 'flex w-full items-center gap-2.5 px-3 py-2 text-left',
  lines: 'flex w-full items-center gap-2.5 py-0.5 text-left',
}

/** The open body's frame: a filled panel under a rule, or an indented rule. */
export const TOOL_CARD_BODY_CLASS: Record<ToolCardStyle, string> = {
  cards: 'border-t border-shell-seam bg-black/[0.28]',
  lines: 'ml-6 border-l border-shell-seam pl-3',
}

/** Body padding. `lines` drops the side padding the indent already supplies. */
export const TOOL_CARD_BODY_INNER_CLASS: Record<ToolCardStyle, string> = {
  cards: 'px-3 pb-2.5 pt-1',
  lines: 'pb-2 pt-1',
}

/** The body's optional sub-label, on the same padding rule as the body. */
export const TOOL_CARD_SUB_CLASS: Record<ToolCardStyle, string> = {
  cards:
    'truncate px-3 pt-1.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.07em] text-text-subtle',
  lines:
    'truncate pt-1.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.07em] text-text-subtle',
}

type PersistedToolCardStyle = { version: 1; style: ToolCardStyle }

type ToolCardStyleStorage = Pick<Storage, 'getItem' | 'setItem'>

export type ToolCardStyleContextValue = {
  style: ToolCardStyle
  setStyle: (next: ToolCardStyle) => void
}

export const ToolCardStyleContext = createContext<ToolCardStyleContextValue>({
  style: DEFAULT_TOOL_CARD_STYLE,
  setStyle: () => {},
})

export function readToolCardStyleFromStorage(
  storage: ToolCardStyleStorage | null,
): ToolCardStyle | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(TOOL_CARD_STYLE_STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<PersistedToolCardStyle>
    if (value.version !== 1 || typeof value.style !== 'string') return null
    return isToolCardStyle(value.style) ? value.style : null
  } catch {
    return null
  }
}

export function writeToolCardStyleToStorage(
  storage: ToolCardStyleStorage | null,
  style: ToolCardStyle,
): void {
  if (!storage) return
  try {
    const value: PersistedToolCardStyle = { version: 1, style }
    storage.setItem(TOOL_CARD_STYLE_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Renderer-owned view persistence is best-effort; a storage failure must not
    // affect live session state (`toolsExpanded.ts`, `workspaceLayout.ts:88`).
  }
}
