/**
 * Tool-run layout — the READ-TIME derivation that folds a run of adjacent
 * same-family tool calls into one grouped card.
 *
 * This closes the seam several parity-ledger rows were blocked on
 * (`GroupedToolGroup` §05, `ReadGroupRow` §05, `GrepCard` §05, `selectReadGroups`
 * §06): the prototype renders a run of reads as ONE `FileReadCard` over a list of
 * `ReadGroupRow`s and a run of searches as ONE `GrepCard` over a list of
 * pattern rows, both dispatched by `GroupedToolGroup` on `groupKind`
 * (`~/catcode_prototype/cat-app/Messages.jsx:580-610`, `:672-698`, `:1057-1091`).
 * The grouped message type was cut while grouping survives as a
 * projector/selector-level grouping over correlated tool rows, with zero new
 * frame types. So this is a derivation over
 * already-projected rows, never a frame, a row mutation, or a new message kind —
 * the same C3 rule `groupAgentDelegates` and `groupReasoningRuns` already follow.
 *
 * GROUPING RULE mirrors the engine's own, `src/utils/collapseReadSearch.ts:762`
 * (`collapseReadSearchGroups`): consecutive collapsible calls accumulate, and
 * anything that is not one flushes the run. The engine breaks on assistant text
 * and on a non-collapsible tool use; here every non-groupable display item is
 * that break, which is the same rule stated over the renderer's item stream.
 *
 * ONE DELIBERATE NARROWING vs the engine: it puts reads and searches in ONE
 * accumulator and prints a combined summary ("Searched for 3 patterns, read 2
 * files"). The prototype has a SEPARATE card per kind, and so does this — a run
 * changes family, it does not merge families. `family` on the item is what the
 * view dispatches on, exactly as `GroupedToolGroup` dispatches on `groupKind`.
 *
 * EDITS GROUP ONLY WITHIN ONE FILE. The engine puts edits in
 * `isNonCollapsibleToolUse` (`collapseReadSearch.ts`), and a mixed-file run would
 * hide what an individual edit card carries: its filename and ±counts. A run of
 * edits to the SAME file hides neither, because the head states the shared path
 * once and sums the counts, while each member keeps its own counts, status and
 * diff. A model routinely sends a dozen small replacements to one file in a
 * single response, and one card per replacement buried the turn
 * (operator-approved, 2026-10-20). So an edit's run key carries its `file_path`,
 * and a change of file ends the run exactly as a change of family does. The key
 * is the INPUT path, not the result's diff path, so a pending call keys the same
 * before and after its result lands. Writes stay out: a write replaces the file
 * whole, so there is no sequence of partial changes to fold.
 */

import type { ReasoningLayoutItem } from './reasoningLayout.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'

export type ToolRunMember = Extract<NestedTranscriptRow, { kind: 'tool-use' }>

/** The families that group. Not every family: see the header. */
export const TOOL_RUN_FAMILIES = ['read', 'grep', 'edit'] as const

export type ToolRunFamily = (typeof TOOL_RUN_FAMILIES)[number]

export type ToolRunItem = {
  kind: 'tool-run'
  family: ToolRunFamily
  /** Stable derivation identity: `<family>-run:<first member row id>`. */
  id: string
  members: ToolRunMember[]
}

/** Every item kind the transcript can render after all read-time derivations. */
export type TranscriptLayoutItem = ReasoningLayoutItem | ToolRunItem

/**
 * A lone call keeps its own card. `groupReasoningRuns` mints a run even for one
 * member and lets the view decide, but a reasoning step has no card of its own to
 * fall back to — a single read or search does, and the prototype agrees: its
 * non-grouped `FileReadCard` / `GrepCard` branches are exactly the one-item case.
 */
export const TOOL_RUN_MIN_MEMBERS = 2

/**
 * The run family this row belongs to, or null if it groups with nothing.
 *
 * A row carrying nested children is excluded: the run body lists members as
 * one-line rows with no place to hang a child list, and dropping children
 * silently is the failure this guard exists to prevent.
 */
export function toolRunFamily(row: NestedTranscriptRow): ToolRunFamily | null {
  if (row.kind !== 'tool-use' || row.children.length > 0) return null
  if (!(TOOL_RUN_FAMILIES as readonly string[]).includes(row.toolFamily)) return null
  // An edit with no named file (a multi-file patch) has no file to share a run on.
  if (row.toolFamily === 'edit' && editRunPath(row) === null) return null
  return row.toolFamily as ToolRunFamily
}

/** The file an edit run is keyed on: the call's own `file_path` input. */
export function editRunPath(row: ToolRunMember): string | null {
  const filePath = row.input['file_path']
  return typeof filePath === 'string' && filePath.length > 0 ? filePath : null
}

/** Rows join one run only while this matches: the family, plus the file for edits. */
function toolRunKey(family: ToolRunFamily, row: ToolRunMember): string {
  return family === 'edit' ? `edit:${editRunPath(row) ?? ''}` : family
}

// Same input-reference caching as `groupReasoningRuns` (`reasoningLayout.ts:177`)
// and `groupAgentDelegates`: the derivation is pure in its single argument and the
// projector keeps item arrays stable while nothing changed, so an unrelated
// re-render hands back the IDENTICAL member arrays and the run card's memo holds.
const runsByItems = new WeakMap<
  readonly TranscriptLayoutItem[],
  readonly TranscriptLayoutItem[]
>()

/**
 * Fold adjacent same-family rows into `tool-run` items, emitted at the position
 * of the first member. Runs shorter than `TOOL_RUN_MIN_MEMBERS` are put back
 * exactly as they arrived, and every other item passes through BY REFERENCE so an
 * agent group or a reasoning run keeps the identity its own derivation gave it.
 *
 * When nothing groups, the input array itself is returned — copying it would throw
 * away the identity the upstream passes cached.
 */
export function groupToolRuns(
  items: readonly TranscriptLayoutItem[],
): readonly TranscriptLayoutItem[] {
  const cached = runsByItems.get(items)
  if (cached) return cached

  const grouped: TranscriptLayoutItem[] = []
  // The family lives INSIDE the run rather than beside it, so there is no state
  // where members exist without one and no pair of variables that can drift.
  let run: {
    family: ToolRunFamily
    key: string
    entries: { item: TranscriptLayoutItem; row: ToolRunMember }[]
  } | null = null
  let foundRun = false

  const flush = (): void => {
    if (run === null) return
    if (run.entries.length < TOOL_RUN_MIN_MEMBERS) {
      for (const entry of run.entries) grouped.push(entry.item)
    } else {
      foundRun = true
      grouped.push({
        kind: 'tool-run',
        family: run.family,
        id: `${run.family}-run:${run.entries[0].row.id}`,
        members: run.entries.map(entry => entry.row),
      })
    }
    run = null
  }

  for (const item of items) {
    if (item.kind === 'single' && item.row.kind === 'tool-use') {
      const row = item.row
      const family = toolRunFamily(row)
      if (family !== null) {
        // A change of family, or of file for edits, ends the previous run and
        // starts a new one, rather than merging two kinds under one head.
        const key = toolRunKey(family, row)
        if (run !== null && run.key !== key) flush()
        run ??= { family, key, entries: [] }
        run.entries.push({ item, row })
        continue
      }
    }
    flush()
    grouped.push(item)
  }
  flush()

  const result = foundRun ? grouped : items
  runsByItems.set(items, result)
  return result
}
