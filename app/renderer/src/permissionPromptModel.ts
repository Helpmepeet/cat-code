import { diffLines } from 'diff'
import type { PermissionUpdate } from '@cat-code/engine/sdk'

export type PermissionKeyboardAction = 'allow' | 'deny' | 'dismiss'

type KeyLike = {
  key: string
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
}

export function permissionActionForKey(
  event: KeyLike,
): PermissionKeyboardAction | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null
  if (event.key === 'Enter') return 'allow'
  if (event.key.toLowerCase() === 'n' || event.key === 'Backspace') return 'deny'
  if (event.key === 'Escape') return 'dismiss'
  return null
}

/**
 * Where the rule would be kept, in the words the engine's own save-destination
 * picker shows a user (`src/components/permissions/rules/AddPermissionRules.tsx:20-37`).
 * `session` and `cliArg` are not settings files at all: they last for the run.
 */
const DESTINATION_LABEL: Record<PermissionUpdate['destination'], string> = {
  localSettings: 'Project settings (local)',
  projectSettings: 'Project settings',
  userSettings: 'User settings',
  session: 'This session',
  cliArg: 'This session',
}

function destinationLabel(destination: PermissionUpdate['destination']): string {
  return DESTINATION_LABEL[destination] ?? 'This session'
}

/**
 * Mode names as this app presents them (`MODE_META`, `PermissionModeChip.tsx`).
 * Duplicated rather than imported because a renderer `.tsx` may export React
 * components only (`lint:fast-refresh`). The total `Record` is the tripwire: a
 * new engine mode fails to compile until it gets a name here.
 */
type SuggestionMode = Extract<PermissionUpdate, { type: 'setMode' }>['mode']

const MODE_LABEL: Record<SuggestionMode, string> = {
  default: 'Ask permissions',
  acceptEdits: 'Accept edits',
  plan: 'Plan mode',
  dontAsk: 'Auto mode',
  bypassPermissions: 'Bypass permissions',
}

export function describeSuggestion(update: PermissionUpdate): string {
  switch (update.type) {
    case 'addRules':
    case 'replaceRules':
    case 'removeRules': {
      const rules = update.rules
        .map(rule =>
          rule.ruleContent
            ? `${rule.toolName}(${rule.ruleContent})`
            : rule.toolName,
        )
        .join(', ')
      return `${update.behavior} ${rules} · ${destinationLabel(update.destination)}`
    }
    case 'setMode':
      return `mode → ${MODE_LABEL[update.mode] ?? update.mode} · ${destinationLabel(update.destination)}`
    case 'addDirectories':
    case 'removeDirectories':
      return `${update.type === 'addDirectories' ? 'allow' : 'remove'} directory ${update.directories.join(', ')} · ${destinationLabel(update.destination)}`
    default: {
      const _exhaustive: never = update
      void _exhaustive
      return 'this permission change'
    }
  }
}

/** One line of an edit preview, in the prototype's `PQDiff` vocabulary
 * (`Permissions.jsx:135-146`). Deliberately carries NO line number: see
 * `buildChangeLines`. */
export type PermissionPreviewLine = {
  kind: 'add' | 'del' | 'ctx'
  text: string
}

/**
 * The legible thing a permission card shows instead of the request's raw input.
 * `null` from `selectPermissionPreview` means "nothing can be promoted
 * honestly" — the card then shows the input itself rather than inventing one.
 */
export type PermissionPreview =
  | { kind: 'field'; label: string; value: string }
  | { kind: 'content'; path: string; body: string }
  | { kind: 'change'; path: string; lines: PermissionPreviewLine[] }

type PreviewShape =
  | { kind: 'field'; label: string; field: string }
  | { kind: 'content'; pathField: string; bodyField: string }
  | { kind: 'change'; pathField: string; fromField: string; toField: string }

/**
 * Which tool families get a promoted field, and which field.
 *
 * The engine picks a per-family permission renderer by TOOL OBJECT IDENTITY
 * (`src/components/permissions/PermissionRequest.tsx:47-82`: `case BashTool:`,
 * `case FileEditTool:`, `case GlobTool: case GrepTool: case FileReadTool:`).
 * Only `tool_name` crosses the wire, and it is that same tool's `name`
 * (`src/app-runtime/appRuntimeCanUseTool.ts:66` `tool_name: tool.name`), so
 * this switch keys on the `*_TOOL_NAME` constant behind each `case` above:
 * `BashTool/toolName.ts:2` 'Bash' · `PowerShellTool/toolName.ts:2`
 * 'PowerShell' · `FileEditTool/constants.ts:2` 'Edit' ·
 * `FileWriteTool/prompt.ts:5` 'Write' · `FileReadTool/prompt.ts:5` 'Read' ·
 * `GlobTool/prompt.ts:1` 'Glob' · `GrepTool/prompt.ts:6` 'Grep' ·
 * `WebFetchTool/prompt.ts:1` 'WebFetch' · `SkillTool/constants.ts:1` 'Skill' ·
 * `NotebookEditTool/constants.ts:2` 'NotebookEdit'.
 *
 * WHICH field each family promotes is not a fresh judgement either: it is the
 * input field that tool's own `renderToolUseMessage` shows, which is the
 * engine's existing per-tool display contract (`BashTool/UI.tsx:92-94`
 * `command` · `WebFetchTool/UI.tsx:9-11` `url` · `SkillTool/UI.tsx:47-48`
 * `skill` · `FileEditTool/UI.tsx:57-58` and `FileWriteTool/UI.tsx:165-173`
 * `file_path` · `FileReadTool/UI.tsx:30-31` `file_path` ·
 * `GlobTool/UI.tsx:14-16` and `GrepTool/UI.tsx:127-129` `pattern` ·
 * `NotebookEditTool/UI.tsx:22-23` `notebook_path`).
 *
 * The engine's own answer for a tool outside its switch is
 * `FallbackPermissionRequest`; ours is `null` here, which shows the request's
 * input as it arrived. AskUserQuestion and the plan-mode tools are absent on
 * purpose: they have their own surfaces (`AskQuestionFlow`, `PlanPanel`) and
 * only reach this card through the deny-only unreadable-question path.
 */
function previewShapeForTool(toolName: string): PreviewShape | null {
  switch (toolName) {
    case 'Bash':
    case 'PowerShell':
      return { kind: 'field', label: 'Command', field: 'command' }
    case 'Edit':
      return {
        kind: 'change',
        pathField: 'file_path',
        fromField: 'old_string',
        toField: 'new_string',
      }
    case 'Write':
      return { kind: 'content', pathField: 'file_path', bodyField: 'content' }
    case 'Read':
      return { kind: 'field', label: 'Path', field: 'file_path' }
    case 'Glob':
    case 'Grep':
      return { kind: 'field', label: 'Pattern', field: 'pattern' }
    case 'WebFetch':
      return { kind: 'field', label: 'URL', field: 'url' }
    case 'Skill':
      return { kind: 'field', label: 'Skill', field: 'skill' }
    case 'NotebookEdit':
      return { kind: 'field', label: 'Notebook', field: 'notebook_path' }
    default:
      return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringAt(input: Record<string, unknown>, field: string): string | null {
  const value = input[field]
  return typeof value === 'string' ? value : null
}

/**
 * The old/new snippet rendered as change lines, WITHOUT numbering.
 *
 * A permission request is pre-execution: it has no `structuredPatch` and the
 * renderer has no filesystem (HC1), so the file's real patch cannot be
 * computed here — the engine's edit card gets one only by reading the file
 * from disk (`src/components/FileEditToolDiff.tsx:129,143`). What IS available
 * is `old_string` vs `new_string`, and a patch over two snippets has its own
 * numbering that does not match the file's. Presenting those as file lines
 * would be a lie, so no number is produced at all: `diffLines` yields runs, and
 * a run only ever becomes a signed line. The prototype's own permission diff
 * has no gutter either (`Permissions.jsx:135-146`), so this agrees with it.
 *
 * Returns null on an empty result or any throw — a permission card degrades to
 * showing the input, it never fails to render.
 */
export function buildChangeLines(
  from: string,
  to: string,
): PermissionPreviewLine[] | null {
  try {
    const lines: PermissionPreviewLine[] = []
    for (const part of diffLines(from, to)) {
      const kind: PermissionPreviewLine['kind'] = part.added
        ? 'add'
        : part.removed
          ? 'del'
          : 'ctx'
      const rows = part.value.split('\n')
      // A part that ends at a line break splits to a trailing empty element;
      // that is the break itself, not a blank line the user wrote.
      if (rows.length > 1 && rows[rows.length - 1] === '') rows.pop()
      for (const row of rows) lines.push({ kind, text: row })
    }
    return lines.length > 0 ? lines : null
  } catch {
    return null
  }
}

/**
 * What this card can show legibly for `tool_name` + `input`, or null when it
 * cannot. `input` is unstructured wire data, so every field is runtime-narrowed
 * and a shape that does not match falls back to null instead of throwing.
 */
export function selectPermissionPreview(
  toolName: string,
  input: unknown,
): PermissionPreview | null {
  const shape = previewShapeForTool(toolName)
  if (!shape || !isRecord(input)) return null

  if (shape.kind === 'field') {
    const value = stringAt(input, shape.field)
    if (value === null || value.length === 0) return null
    return { kind: 'field', label: shape.label, value }
  }

  const path = stringAt(input, shape.pathField)
  if (path === null || path.length === 0) return null

  if (shape.kind === 'content') {
    // An empty body is a real request: writing an empty file.
    const body = stringAt(input, shape.bodyField)
    return body === null ? null : { kind: 'content', path, body }
  }

  const from = stringAt(input, shape.fromField)
  const to = stringAt(input, shape.toField)
  if (from === null || to === null) return null
  const lines = buildChangeLines(from, to)
  return lines === null ? null : { kind: 'change', path, lines }
}

/**
 * The request's input as it arrived, for the card's disclosure. Model-authored
 * input can hold anything, so a value `JSON.stringify` refuses still has to
 * render something rather than take the card down with it.
 */
export function formatPermissionInput(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2) ?? String(input)
  } catch {
    return String(input)
  }
}
