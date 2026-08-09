/**
 * Which tool cards the user has opened by hand, remembered ABOVE the read-time
 * derivations that decide how those cards are drawn.
 *
 * WHY THIS EXISTS. Card expansion used to be `useState` inside `ToolCardShell`,
 * which is correct exactly as long as a card keeps its React identity. The
 * grouping derivation (`toolRunLayout.ts`) breaks that: the moment a second
 * adjacent read arrives, a lone read stops being a `TranscriptRowView`/`ToolCard`
 * keyed `<row id>` and becomes a `ToolRunRow` inside a run keyed
 * `read-run:<row id>`. Both the key AND the component type change, so React
 * unmounts the old tree and the user's expansion dies with it. Mid-turn that reads
 * as a file snapping shut a second after they opened it, which is why local state
 * cannot own this once rows can regroup underneath the user.
 *
 * IDENTITY IS `toolUseId`, not the row id and not the display key: it is minted by
 * the engine for the tool call itself and is the one handle that survives a row
 * being re-projected, re-nested, or folded into a run.
 *
 * GROWTH. One entry per card the user actually CLICKS, never one per tool call, so
 * this tracks deliberate interactions rather than transcript size — a session that
 * runs ten thousand tools and opens six cards holds six entries. The store lives as
 * long as the transcript view is mounted (`TranscriptView` is mounted once by
 * `App`, not per session), and `toolUseId` is globally unique, so nothing collides
 * across a session switch.
 */

import { createContext, useContext, useReducer, useRef } from 'react'
import { resolveToolCardExpanded } from './transcriptViewModel.js'

export type ToolCardExpansionStore = {
  /** The user's choice for this card, or undefined if they never touched it. */
  get(toolUseId: string): boolean | undefined
  set(toolUseId: string, expanded: boolean): void
  /** Number of inline output lines the user has revealed for this card. */
  getInlineOutputHead(toolUseId: string): number | undefined
  setInlineOutputHead(toolUseId: string, headShown: number): void
}

/**
 * Null by default so a card rendered outside a transcript — a unit test, a bare
 * mount — still toggles, using per-instance memory instead. A missing provider
 * degrades to the old behaviour rather than dropping clicks on the floor.
 */
export const ToolCardExpansionContext =
  createContext<ToolCardExpansionStore | null>(null)

/**
 * A store backed by a plain Map. Deliberately NOT React state: writing through
 * `useState` here would re-render the whole transcript on every card toggle, and
 * the only component that needs to react to a toggle is the card that was clicked.
 * It re-renders itself; everyone else reads the same value they already had.
 */
export function createToolCardExpansionStore(): ToolCardExpansionStore {
  const opened = new Map<string, boolean>()
  const inlineOutputHeads = new Map<string, number>()
  return {
    get: toolUseId => opened.get(toolUseId),
    set: (toolUseId, expanded) => {
      opened.set(toolUseId, expanded)
    },
    getInlineOutputHead: toolUseId => inlineOutputHeads.get(toolUseId),
    setInlineOutputHead: (toolUseId, headShown) => {
      inlineOutputHeads.set(toolUseId, headShown)
    },
  }
}

/** The key a card with no engine identity uses in its own private map. */
const ANONYMOUS_KEY = 'self'

/**
 * The ambient store, for a component that must record something about a card OTHER
 * than its own (a run row pinning its run open). Null outside a transcript.
 */
export function useToolCardExpansionStore(): ToolCardExpansionStore | null {
  return useContext(ToolCardExpansionContext)
}

/**
 * Did the user explicitly open any of these calls?
 *
 * A run head needs this or the memory below is useless in the case it exists for:
 * a read the user opened as a lone card folds into a run whose head is collapsed
 * by default, and their file disappears anyway — the expansion remembered, the
 * content still gone. A run that contains something they opened opens with it.
 *
 * Only an explicit `true` counts. A member they deliberately CLOSED must not drag
 * the head open, which is why this tests the stored value rather than its presence.
 *
 * This decides the FIRST render after a regroup only. Once the user touches any
 * member the run has its own stored answer (`ToolRunRow` pins it), so the head
 * stops depending on a value the user can flip out from under it.
 */
export function useAnyToolCardOpened(toolUseIds: readonly string[]): boolean {
  const store = useContext(ToolCardExpansionContext)
  if (store === null) return false
  return toolUseIds.some(id => store.get(id) === true)
}

/**
 * A card's expansion, resolved from the same THREE inputs as before
 * (`resolveToolCardExpanded`): the user's own choice wins, otherwise the card's
 * `defaultExpanded` decides on every render — so a live pending→error flip still
 * opens the card.
 *
 * The only change is WHERE the user's choice is kept. Reading it from a map keyed
 * on the current `toolUseId` during render means a remounted card picks its answer
 * back up, and an instance reused under a different card cannot show the previous
 * card's state — there is no per-instance value to go stale.
 */
export function useToolCardExpanded(
  toolUseId: string | null,
  defaultExpanded: boolean,
): [boolean, (next: boolean) => void] {
  const shared = useContext(ToolCardExpansionContext)
  const privateStore = useRef<ToolCardExpansionStore | null>(null)
  privateStore.current ??= createToolCardExpansionStore()
  // A toggle changes a Map, which React cannot see; this is what re-renders the
  // one card that was clicked.
  const [, bump] = useReducer((count: number) => count + 1, 0)

  // No shared store, or no engine identity to key by: remember it per instance.
  const store = shared !== null && toolUseId !== null ? shared : privateStore.current
  const key = shared !== null && toolUseId !== null ? toolUseId : ANONYMOUS_KEY

  const expanded = resolveToolCardExpanded(
    store.get(key) ?? null,
    defaultExpanded,
  )
  return [
    expanded,
    (next: boolean) => {
      store.set(key, next)
      bump()
    },
  ]
}
