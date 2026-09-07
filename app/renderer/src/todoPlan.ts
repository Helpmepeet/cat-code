import type { NestedTranscriptRow } from './transcriptProjector.js'

/**
 * The session's todo plan, derived at read time from the newest `TodoWrite`
 * tool call in the transcript.
 *
 * ## Why this is a derivation and not a frame
 *
 * `TodoWriteTool` carries the WHOLE list on every call: its `inputSchema` is
 * `{ todos: TodoList }` (`src/tools/TodoWriteTool/TodoWriteTool.ts`) and its
 * `call` replaces rather than patches (it reads `oldTodos`, writes `newTodos`).
 * So the newest call's `input.todos` IS the current plan, and the
 * projector already stores tool input verbatim on the row
 * (`transcriptProjector.ts` `ToolUseRow.input`). No protocol change, no new
 * frame kind, no sidecar validation surface — the same C3 read-time rule
 * `groupToolRuns` and `selectPlanReview` already follow.
 *
 * The tool result is deliberately NOT read. It is a fixed acknowledgement
 * sentence ("Todos have been modified successfully…", returned by that same
 * `call`) that carries no list, so a plan is legible the moment
 * the call is projected rather than after it settles.
 *
 * ## Why the desktop only ever sees `TodoWrite`
 *
 * The engine gates the V1 tool on `!isTodoV2Enabled()` (`TodoWriteTool.isEnabled`)
 * and the V2 `TaskCreate/TaskUpdate/TaskList` set on `isTodoV2Enabled()`
 * (`src/tools.ts` `getAllBaseTools`), which resolves to `CLAUDE_CODE_ENABLE_TASKS` or
 * session interactivity (`src/utils/tasks.ts` `isTodoV2Enabled`). The sidecar
 * never calls `setIsInteractive` — the only call site is `src/main.tsx` — so
 * `STATE.isInteractive` keeps its `false` default (`src/bootstrap/state.ts`)
 * and every desktop session gets `TodoWrite`. One tool to read, not two.
 *
 * ## Top-level rows only
 *
 * A subagent keys its own list by `context.agentId` (in `TodoWriteTool.call`), so a
 * nested `TodoWrite` belongs to that worker and not to this thread. Scanning only
 * top-level rows keeps the two apart, the same scope `deriveActivity` uses.
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export type TodoPlanItem = {
  content: string
  status: TodoStatus
  /** The present-participle form the engine writes for live display. */
  activeForm: string
}

export type TodoPlan = {
  items: TodoPlanItem[]
  /** 1-based position of the in-progress item, or null when none is running. */
  step: number | null
  total: number
}

/** `TODO_WRITE_TOOL_NAME` (`src/tools/TodoWriteTool/constants.ts:1`). */
const TODO_WRITE_TOOL_NAME = 'TodoWrite'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function toStatus(value: unknown): TodoStatus | null {
  return value === 'pending' || value === 'in_progress' || value === 'completed'
    ? value
    : null
}

/**
 * One item, runtime-narrowed from the wire with no casts. `content` and
 * `activeForm` are `z.string().min(1)` engine-side
 * (`src/utils/todo/types.ts:8-13`), so an item missing either is drift rather
 * than a shape this display should invent a default for: it is dropped.
 */
function narrowItem(value: unknown): TodoPlanItem | null {
  if (!isRecord(value)) return null
  const content = nonEmptyString(value['content'])
  const activeForm = nonEmptyString(value['activeForm'])
  const status = toStatus(value['status'])
  if (content === null || activeForm === null || status === null) return null
  return { content, activeForm, status }
}

function narrowPlan(input: Record<string, unknown>): TodoPlan | null {
  const todos = input['todos']
  if (!Array.isArray(todos)) return null
  const items: TodoPlanItem[] = []
  for (const entry of todos) {
    const item = narrowItem(entry)
    if (item !== null) items.push(item)
  }
  // Only a literally empty list is null here. The engine's `allDone ? [] : todos`
  // clears what it STORES in app state; we read the model-authored tool input,
  // which on the call that closes a run still carries every completed item. So
  // that call returns a plan with no current step, and the surface is hidden one
  // layer down by `selectTodoReadout`, which requires a step to render.
  if (items.length === 0) return null
  const index = items.findIndex(item => item.status === 'in_progress')
  return {
    items,
    step: index === -1 ? null : index + 1,
    total: items.length,
  }
}

/**
 * The live plan, or null when this session has none. Walks backward so the
 * newest call wins without materialising the whole list of matches.
 */
export function selectTodoPlan(rows: readonly NestedTranscriptRow[]): TodoPlan | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row === undefined) continue
    if (row.kind !== 'tool-use') continue
    if (row.toolName !== TODO_WRITE_TOOL_NAME) continue
    return narrowPlan(row.input)
  }
  return null
}

/**
 * The compact readout that rides the activity byline: the step you are on out
 * of the whole plan. Null when nothing is in progress — right after a plan is
 * written and before its first item starts, there is no step to name, and a
 * readout that guessed `1/5` would claim work that has not begun.
 */
export function selectTodoReadout(plan: TodoPlan | null): string | null {
  if (plan === null || plan.step === null) return null
  return `${plan.step}/${plan.total}`
}

/**
 * The same rows with every `TodoWrite` call removed, at any nesting depth.
 *
 * The plan is read from these rows but never DRAWN as one (operator call,
 * 2026-08-29): a todo card in the transcript prints the engine's fixed
 * acknowledgement sentence and repeats a list that the activity byline already
 * carries live, so it is noise on the one surface that should read as the
 * conversation. The row stays in the projection — `selectTodoPlan` needs it —
 * and is dropped only at display.
 *
 * Identity is preserved the way `groupToolRuns` preserves it
 * (`toolRunLayout.ts` `runsByItems`): a subtree with nothing to remove is
 * returned BY REFERENCE, so the memo that skips the whole transcript when a
 * session's slice did not change still holds (`TranscriptView.tsx:262-266`).
 * Copying unconditionally would re-render every row on every keystroke in the
 * composer.
 */
const strippedByRows = new WeakMap<
  readonly NestedTranscriptRow[],
  NestedTranscriptRow[]
>()

function isTodoRow(row: NestedTranscriptRow): boolean {
  return row.kind === 'tool-use' && row.toolName === TODO_WRITE_TOOL_NAME
}

export function withoutTodoRows(
  rows: NestedTranscriptRow[],
): NestedTranscriptRow[] {
  const cached = strippedByRows.get(rows)
  if (cached !== undefined) return cached

  let changed = false
  const kept: NestedTranscriptRow[] = []
  for (const row of rows) {
    if (isTodoRow(row)) {
      changed = true
      continue
    }
    // A subagent keeps its own list, and its card is just as empty as the
    // parent's would be, so the same rule applies inside an Agent card.
    if (row.children.length > 0) {
      const children = withoutTodoRows(row.children)
      if (children !== row.children) {
        changed = true
        kept.push({ ...row, children })
        continue
      }
    }
    kept.push(row)
  }

  const result = changed ? kept : rows
  strippedByRows.set(rows, result)
  return result
}
