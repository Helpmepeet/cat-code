import { diffLines } from 'diff'
import type { PermissionUpdate } from '@cat-code/engine/sdk'
import type { PermissionRequest } from './permissionState.js'

/**
 * What a key press does to the card's option list. The card is a keyboard-driven
 * SELECT LIST (`Permissions.jsx:10-13`), so a key either moves the cursor, picks
 * a row outright, confirms the row under the cursor, or refuses.
 *
 * `deny` is its own intent rather than "pick the last row" because two keys
 * reach it without touching the cursor: Escape, which the deny row advertises
 * with its `esc` chip, and the `n`/⌫ pair this app added.
 */
export type PermissionKeyIntent =
  | { kind: 'move'; delta: 1 | -1 }
  | { kind: 'pick'; index: number }
  | { kind: 'confirm' }
  | { kind: 'deny' }

type KeyLike = {
  key: string
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
}

/**
 * The prototype's key map (`Permissions.jsx:385-398`): ↑/↓ · j/k · ⌃P/⌃N move,
 * 1–9 pick directly, Enter confirms the highlighted row, Esc refuses.
 *
 * Ctrl is allowed through for exactly the ⌃P/⌃N pair, which is why this cannot
 * simply reject every modified key: Cmd and Alt still bail, so the shell's own
 * ⌘-chords (⌘T/⌘W/⌘1-9) never collide.
 */
export function permissionKeyIntent(event: KeyLike): PermissionKeyIntent | null {
  if (event.altKey || event.metaKey) return null
  const key = event.key
  if (event.ctrlKey) {
    if (key === 'n') return { kind: 'move', delta: 1 }
    if (key === 'p') return { kind: 'move', delta: -1 }
    return null
  }
  if (key === 'ArrowDown' || key === 'j') return { kind: 'move', delta: 1 }
  if (key === 'ArrowUp' || key === 'k') return { kind: 'move', delta: -1 }
  if (/^[1-9]$/.test(key)) return { kind: 'pick', index: Number(key) - 1 }
  if (key === 'Enter') return { kind: 'confirm' }
  // Escape is the prototype's reject (`Permissions.jsx:13`), NOT a hide: the
  // hide-for-later lane is the footer's "Keep pending", which leaves the request
  // live engine-side.
  if (key === 'Escape') return { kind: 'deny' }
  if (key.toLowerCase() === 'n' || key === 'Backspace') return { kind: 'deny' }
  return null
}

/**
 * Elements that already act on Enter/Escape themselves. The plain-key permission
 * shortcuts are a shortcut for "focus is on nothing"; whenever focus sits inside
 * one of these the focused control decides, so Enter on the card's own Deny
 * button denies instead of being swallowed and answered as an allow.
 *
 * A tag-name test is not enough: buttons, menu items and dialog contents all
 * carry their own Enter semantics, and `preventDefault()` on the shortcut path
 * suppresses the browser's Enter → click.
 */
const FOCUSED_KEY_OWNER_SELECTOR =
  'a[href], button, input, select, textarea, [contenteditable], ' +
  '[role="button"], [role="menu"], [role="menuitem"], [role="menuitemradio"], ' +
  '[role="menuitemcheckbox"], [role="option"], [role="listbox"], ' +
  '[role="dialog"], [role="alertdialog"]'

/**
 * Marks the ONE card the four shortcuts act on (`selectVisiblePermission`'s
 * pick) as the element that HOSTS the keys rather than owning them.
 *
 * It exists because the card's own `<section>` is `role="alertdialog"`, which is
 * in the selector above, and `closest()` matches the element itself and not only
 * its ancestors. Focusing the card so the composer stops swallowing keys would
 * therefore make the card its own key owner and leave all four keys exactly as
 * dead as leaving focus in the composer did.
 */
export const PERMISSION_KEY_HOST_ATTR = 'data-permission-key-host'

/** The `hasAttribute` slice of an `Element`, so this stays unit-testable. */
type KeyOwnerLike = { hasAttribute(name: string): boolean }
/** The `closest` slice of an `Element` (a keydown/focus target). */
type KeyTargetLike = { closest(selector: string): KeyOwnerLike | null }

function isKeyTarget(value: unknown): value is KeyTargetLike {
  if (typeof value !== 'object' || value === null) return false
  return typeof Reflect.get(value, 'closest') === 'function'
}

/**
 * Whether the four permission shortcuts are live for a given focus target.
 *
 * Live when focus is on nothing element-like (`document`, `window`, `null`), on
 * an element that owns no keys of its own, or on the marked host card. Dead
 * everywhere else: the composer field it starts in, and every button on the
 * card, including each option row and the footer's own controls, where Enter
 * must click the thing under focus rather than confirm the cursor's row.
 *
 * One predicate serves both consumers on the card so they can never disagree:
 * its keydown listener decides whether to act, and its footer decides whether to
 * advertise.
 */
export function permissionKeysAreLive(target: unknown): boolean {
  if (!isKeyTarget(target)) return true
  const owner = target.closest(FOCUSED_KEY_OWNER_SELECTOR)
  if (owner === null) return true
  return owner.hasAttribute(PERMISSION_KEY_HOST_ATTR)
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
  dontAsk: "Don't ask",
  bypassPermissions: 'Bypass permissions',
}

function formatRules(update: Extract<PermissionUpdate, { rules: unknown }>): string {
  return update.rules
    .map(rule =>
      rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName,
    )
    .join(', ')
}

export function describeSuggestion(update: PermissionUpdate): string {
  switch (update.type) {
    case 'addRules':
    case 'replaceRules':
    case 'removeRules': {
      const rules = formatRules(update)
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

/**
 * How a non-allow rule suggestion leads its row. `behavior` is the one engine
 * enum this module used to print raw, which produced rows reading "Yes, and
 * deny `Bash(rm:*)`" next to a row whose effect is an allow. The total `Record`
 * is the tripwire: a new behavior fails to compile until it gets a phrasing.
 */
const BEHAVIOR_LEAD: Record<
  Extract<PermissionUpdate, { behavior: string }>['behavior'],
  string
> = {
  allow: "Yes, and don't ask again for ",
  deny: 'Yes, and always block ',
  ask: 'Yes, and always ask for ',
}

/**
 * The suggestion phrased as an option row. The prototype writes this line as
 * "Yes, and don't ask again for `<scope>`" (`Permissions.jsx:112`), where its
 * mock derived `<scope>` client-side; here the chip is the ENGINE's own
 * serialization and the trailing text says where the rule would be kept, which
 * the prototype's mock had no concept of.
 *
 * A suggestion on an ask is an allow-rule in practice, so that phrasing leads.
 * The other update types keep the engine's own vocabulary rather than a phrasing
 * invented for a case the prototype never had.
 */
export function describeSuggestionOption(update: PermissionUpdate): {
  pre: string
  code: string
  post: string
} {
  const post = ` · ${destinationLabel(update.destination)}`
  switch (update.type) {
    case 'addRules':
    case 'replaceRules':
      return update.behavior === 'allow'
        ? { pre: "Yes, and don't ask again for ", code: formatRules(update), post }
        : { pre: BEHAVIOR_LEAD[update.behavior], code: formatRules(update), post }
    case 'removeRules':
      return { pre: 'Yes, and stop applying ', code: formatRules(update), post }
    case 'setMode':
      return {
        pre: 'Yes, and switch to ',
        code: MODE_LABEL[update.mode] ?? update.mode,
        post,
      }
    case 'addDirectories':
      return {
        pre: 'Yes, and add directory ',
        code: update.directories.join(', '),
        post,
      }
    case 'removeDirectories':
      return {
        pre: 'Yes, and remove directory ',
        code: update.directories.join(', '),
        post,
      }
    default: {
      const _exhaustive: never = update
      void _exhaustive
      return { pre: 'Yes, and apply this permission change', code: '', post: '' }
    }
  }
}

/**
 * One row of the card's select list, in the prototype's option grammar
 * (`Permissions.jsx:86-133`): leading text, an optional mono chip carrying the
 * scope, then trailing text.
 *
 * The chip is always ENGINE-authored. The prototype synthesised it client-side
 * (`scopeFromRule`, `dirOf`), which this app cannot do: a row that names a scope
 * different from the one that would actually persist is a correctness bug, so
 * rule rows exist only where the engine minted a suggestion, and answering one
 * selects it BY INDEX (decisions/PERMISSION-BOUNDARY.md §2, C1).
 */
export type PermissionOption = {
  id: string
  pre: string
  code?: string
  post?: string
  effect: 'allow' | 'rule' | 'deny'
  /** Index into this request's `permission_suggestions`; `rule` rows only. */
  suggestionIndex?: number
  /** Escape picks this row, and the row advertises that with an `esc` chip. */
  esc?: boolean
}

/**
 * The rows for one request, in the prototype's order: allow-once, then one row
 * per rule the engine offered, then refuse.
 *
 * `denyOnly` drops every allow path. An AskUserQuestion whose questions cannot
 * be read falls back to this card, and a bare allow there would run the tool
 * with NO answers (decisions/ASK-USER-QUESTION-ANSWER.md). Mouse and keyboard
 * both read this list, so they cannot disagree about what row 1 does.
 */
export function buildPermissionOptions(
  request: PermissionRequest['request'],
  denyOnly = false,
): PermissionOption[] {
  const deny: PermissionOption = {
    id: 'deny',
    pre: 'No, and tell Cat Code what to do differently',
    effect: 'deny',
    esc: true,
  }
  if (denyOnly) return [deny]
  const suggestions = Array.isArray(request.permission_suggestions)
    ? request.permission_suggestions
    : []
  return [
    { id: 'allow', pre: 'Yes', effect: 'allow' },
    ...suggestions.map((suggestion, index): PermissionOption => {
      const { pre, code, post } = describeSuggestionOption(suggestion)
      return {
        id: `rule-${index}`,
        pre,
        code,
        post,
        effect: 'rule',
        suggestionIndex: index,
      }
    }),
    deny,
  ]
}

/**
 * The card's uppercase kicker, keyed on the same `tool_name` families the
 * preview switch uses. The prototype carries one per variant
 * (`Permissions.jsx:61-75` `kicker`); these are its words for the families that
 * survived, and `Permission` is its fallback's.
 */
export function permissionKickerForTool(
  toolName: string,
  relayed = false,
): string {
  // The prototype gives a relayed request its own kicker word
  // (`Permissions.jsx:73` `PV.worker`), because what is being approved is
  // another agent's request, not this session's.
  if (relayed) return 'Worker request'
  switch (toolName) {
    case 'Read':
    case 'Glob':
    case 'Grep':
      return 'Filesystem'
    case 'WebFetch':
      return 'Web access'
    case 'Skill':
      return 'Skill'
    default:
      return 'Permission'
  }
}

/**
 * Whether the command itself is the card's headline rather than its body.
 *
 * The prototype inlines the preview into the title for its pure-command variants
 * only (`Permissions.jsx:411-412`: bash, powershell, worker), and shows every
 * other family a labelled body block.
 *
 * Derived from `previewShapeForTool` rather than re-listing the command tools:
 * the two lists were identical by hand, so adding a command family to the
 * preview switch silently regressed its headline to "Allow &lt;tool&gt;?" with no
 * test failing. One table owns family knowledge now, and `COMMAND_LABEL` is
 * what ties the two together instead of a repeated string literal.
 */
export function permissionTitleIsInlineCommand(toolName: string): boolean {
  const shape = previewShapeForTool(toolName)
  return shape !== null && shape.kind === 'field' && shape.label === COMMAND_LABEL
}

/** Longest command a headline carries whole. Past this it is summarised, and the
 * body block below the headline shows the command in full. */
export const PERMISSION_TITLE_COMMAND_MAX = 120

/**
 * The command as a headline, plus whether that headline is the whole command.
 *
 * The prototype could inline its preview unconditionally because its mock
 * commands were short one-liners; real `Bash` input is arbitrary-length and
 * frequently multi-line (`src/tools/BashTool/BashTool.tsx:228`), and a title
 * line cannot hold a heredoc. So a long or multi-line command is cut to its
 * first line here and reported as truncated, which is the caller's cue to keep
 * rendering the body block. Nothing is ever hidden by shortening: `truncated`
 * has exactly one consumer and it re-shows the full text.
 */
export function summariseCommandForTitle(command: string): {
  text: string
  truncated: boolean
} {
  // Surrounding whitespace is not content, at EITHER end. A model-emitted
  // command very often ends in a newline, and measuring against the raw string
  // reported every one of those as multi-line: a headline with a misleading
  // ellipsis over a body block re-rendering a command that fitted perfectly.
  // Stripping only the tail left the same false report for a command that
  // OPENS with a blank line.
  const content = command.replace(/^\s+|\s+$/g, '')
  // The FIRST NON-BLANK line, because a command that opens with a newline gave
  // `firstLine === ''` and rendered `Allow  …?`, naming no command at all: the
  // exact defect the inline headline exists to fix.
  const lines = content.split('\n')
  const firstIndex = lines.findIndex(line => line.trim().length > 0)
  if (firstIndex === -1) return { text: '', truncated: false }
  const firstLine = (lines[firstIndex] ?? '').replace(/\r$/, '')
  const more = firstIndex > 0 || firstIndex < lines.length - 1
  if (firstLine.length <= PERMISSION_TITLE_COMMAND_MAX) {
    return more
      ? { text: `${firstLine} …`, truncated: true }
      : { text: firstLine, truncated: false }
  }
  return {
    text: `${firstLine.slice(0, PERMISSION_TITLE_COMMAND_MAX)} …`,
    truncated: true,
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

/** The one label that also decides the headline form; see
 * `permissionTitleIsInlineCommand`. Named so the two cannot drift apart. */
const COMMAND_LABEL = 'Command'

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
      return { kind: 'field', label: COMMAND_LABEL, field: 'command' }
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
