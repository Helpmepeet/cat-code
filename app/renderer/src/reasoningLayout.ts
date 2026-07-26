/**
 * Reasoning-summary layout — a RENDERER-LOCAL view preference plus the read-time
 * derivation that turns reasoning rows into trail steps.
 *
 * WIRE SHAPES this must survive (verified in the Codex adapter, which is what
 * hosted GPT models reach the app through):
 *  - One Codex `reasoning` item becomes exactly ONE `thinking` block, and the
 *    several summary PARTS inside it are merged into that block joined by
 *    "\n\n" (`src/services/api/codex-fetch-adapter.ts:2018-2031`). So the common
 *    "several headings" turn arrives as ONE row carrying N headings — splitting
 *    on the blank line is what recovers the steps. Separate rows happen when the
 *    turn had separate reasoning items, which usually means a tool call ran
 *    between them (the adapter closes reasoning blocks before tool blocks "so
 *    ordinal positions in content[] line up", `:1921-1923`).
 *  - Encrypted-only reasoning is NOT a `redacted_thinking` block on this path:
 *    the adapter synthesizes `{type:'thinking', thinking:'', signature}` to carry
 *    the blob (`:2207-2235`). An empty/blank body therefore means "nothing to
 *    read", never "a heading that happens to be empty".
 *  - `reasoningKind` ('summary' | 'raw') rides the row when the provider stated
 *    it (`claude.ts:2211-2216` → `transcriptProjector.ts:157`). A raw trace is
 *    reasoning TEXT, not a heading, whatever its length.
 *
 * `blocks` keeps the original `ThinkingBlock` treatment, which was designed
 * around long-form reasoning prose. `trail` is the alternative for models that
 * only expose short headings. Both ship; this module owns the selector.
 *
 * NOT an engine setting. Every key in `app/shared/settingsEditable.ts` is a real
 * `SettingsSchema` key the sidecar writes to disk — including `reasoningDisplay`
 * ('off' | 'summary' | 'raw'), which decides WHICH reasoning is shown and is a
 * different axis from this one. Layout is a desktop rendering choice with no
 * engine meaning, so it persists like the workspace layout: versioned JSON in
 * the renderer's own storage, best-effort (`workspaceLayout.ts:71`).
 */

import { createContext } from 'react'
import type {
  NestedTranscriptRow,
  TranscriptDisplayItem,
} from './transcriptProjector.js'

export const REASONING_LAYOUT_STORAGE_KEY = 'catcode.reasoningLayout.v1'

export const REASONING_LAYOUT_MODES = ['trail', 'blocks'] as const

export type ReasoningLayoutMode = (typeof REASONING_LAYOUT_MODES)[number]

export const REASONING_LAYOUT_LABELS: Readonly<
  Record<ReasoningLayoutMode, string>
> = {
  trail: 'Trail (one line per summary)',
  blocks: 'Blocks (expanded reasoning card)',
}

export const DEFAULT_REASONING_LAYOUT: ReasoningLayoutMode = 'trail'

/** The fixed phrase for a step with nothing to read. One constant: the lone-row
 * and in-run forms must never drift apart. */
export const REASONING_WITHHELD_TEXT = 'reasoning not shared by the provider'

/**
 * Heading-length guard. The wire carries no "this is a heading" flag, only
 * `reasoningKind`, so a body that is one line AND short is treated as a label;
 * anything longer keeps its prose. The cap is this build's judgement (the
 * approved design states the rule as single-line vs multi-line) — it exists so a
 * single-line 400-character paragraph is not rendered as a label.
 */
export const REASONING_HEADING_MAX_CHARS = 140

type ReasoningLayoutStorage = Pick<Storage, 'getItem' | 'setItem'>

type PersistedReasoningLayout = {
  version: 1
  mode: ReasoningLayoutMode
}

export function isReasoningLayoutMode(
  value: unknown,
): value is ReasoningLayoutMode {
  return (
    typeof value === 'string' &&
    (REASONING_LAYOUT_MODES as readonly string[]).includes(value)
  )
}

export function readReasoningLayoutFromStorage(
  storage: ReasoningLayoutStorage | null,
): ReasoningLayoutMode | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(REASONING_LAYOUT_STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<PersistedReasoningLayout>
    if (value.version !== 1 || !isReasoningLayoutMode(value.mode)) return null
    return value.mode
  } catch {
    return null
  }
}

export function writeReasoningLayoutToStorage(
  storage: ReasoningLayoutStorage | null,
  mode: ReasoningLayoutMode,
): void {
  if (!storage) return
  try {
    const value: PersistedReasoningLayout = { version: 1, mode }
    storage.setItem(REASONING_LAYOUT_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Renderer-owned view persistence is best-effort; a storage failure must not
    // affect the live session/control-plane state (workspaceLayout.ts:88).
  }
}

export type ReasoningLayoutContextValue = {
  mode: ReasoningLayoutMode
  setMode: (mode: ReasoningLayoutMode) => void
}

/**
 * Published by `App` so both consumers read one value without threading a prop
 * through `SessionPane`: the transcript (which renders the rows) and the
 * Settings "Theme & Output" pane (which sets it). Same context idiom as
 * `ToolInspectorContext` (`TranscriptView.tsx:74`). The default keeps a
 * component rendered outside the provider (a unit test, SSR) on the default mode
 * with an inert setter.
 */
export const ReasoningLayoutContext = createContext<ReasoningLayoutContextValue>(
  { mode: DEFAULT_REASONING_LAYOUT, setMode: () => {} },
)

export type ReasoningRunMember = Extract<
  NestedTranscriptRow,
  { kind: 'thinking' } | { kind: 'redacted-thinking' }
>

/**
 * One rendered step. `heading` is a label drawn as plain text; `prose` is
 * reasoning text drawn through the markdown path; `withheld` carries no text at
 * all, because the underlying block had none to give.
 */
export type ReasoningStepModel =
  | { key: string; kind: 'heading'; text: string }
  | { key: string; kind: 'prose'; text: string }
  | { key: string; kind: 'withheld' }

export type ReasoningRunItem = {
  kind: 'reasoning-run'
  /** Stable derivation identity: `reasoning-run:<first member row id>`. */
  id: string
  steps: ReasoningStepModel[]
}

export type ReasoningLayoutItem = TranscriptDisplayItem | ReasoningRunItem

export function isReasoningRow(
  row: NestedTranscriptRow,
): row is ReasoningRunMember {
  return row.kind === 'thinking' || row.kind === 'redacted-thinking'
}

export function isHeadingLike(text: string): boolean {
  const trimmed = text.trim()
  return (
    trimmed.length > 0 &&
    !trimmed.includes('\n') &&
    trimmed.length <= REASONING_HEADING_MAX_CHARS
  )
}

/**
 * One reasoning ROW → its steps. A blank body is `withheld` (the encrypted-only
 * shape), a provider-stated raw trace is always prose, and a summary body splits
 * on the blank line the adapter joins parts with — but only when EVERY part is
 * heading-length, so a genuinely long body is never chopped into pseudo-labels.
 */
export function reasoningStepsForRow(
  row: ReasoningRunMember,
): ReasoningStepModel[] {
  if (row.kind === 'redacted-thinking' || row.content.trim().length === 0) {
    return [{ key: `${row.id}:withheld`, kind: 'withheld' }]
  }
  if (row.reasoningKind === 'raw') {
    return [{ key: `${row.id}:0`, kind: 'prose', text: row.content }]
  }
  const parts = row.content
    .split(/\n{2,}/)
    .map(part => part.trim())
    .filter(part => part.length > 0)
  if (parts.length > 1 && parts.every(isHeadingLike)) {
    return parts.map((text, index) => ({
      key: `${row.id}:${index}`,
      kind: 'heading',
      text,
    }))
  }
  return isHeadingLike(row.content)
    ? [{ key: `${row.id}:0`, kind: 'heading', text: row.content.trim() }]
    : [{ key: `${row.id}:0`, kind: 'prose', text: row.content }]
}

/**
 * READ-TIME derivation, never a frame or a projector row change (the C3 rule
 * `groupAgentDelegates` already follows, `transcriptProjector.ts:501`): ADJACENT
 * reasoning rows become one `reasoning-run` item, emitted at the position of the
 * first member, carrying the flattened steps of every member. Any other row
 * between two reasoning rows starts a new run.
 *
 * A run is minted even for a single step — the VIEW decides that one step draws
 * as one line rather than a head plus a rail, because that choice is layout, not
 * data. Non-reasoning items pass through by reference, so a DelegateGroup keeps
 * its identity.
 */
export function groupReasoningRuns(
  items: readonly TranscriptDisplayItem[],
): ReasoningLayoutItem[] {
  const grouped: ReasoningLayoutItem[] = []
  let run: ReasoningRunMember[] = []

  const flush = (): void => {
    if (run.length === 0) return
    grouped.push({
      kind: 'reasoning-run',
      id: `reasoning-run:${run[0].id}`,
      steps: run.flatMap(reasoningStepsForRow),
    })
    run = []
  }

  for (const item of items) {
    if (item.kind === 'single' && isReasoningRow(item.row)) {
      run.push(item.row)
      continue
    }
    flush()
    grouped.push(item)
  }
  flush()
  return grouped
}

/** Wrap plain rows as display items — the nested-children lists (subagent /
 * tool-card children) have no agent grouping of their own but still group their
 * reasoning runs. */
export function toDisplayItems(
  rows: readonly NestedTranscriptRow[],
): TranscriptDisplayItem[] {
  return rows.map(row => ({ kind: 'single', row }))
}
