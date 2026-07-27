/**
 * The Settings surface's SUBJECT: which configuration scope the operator chose,
 * what a row may state about that scope's files, and where a write lands.
 *
 * The rebuilt surface rests on three laws
 * (`docs/migration/specs/2026-07-27-settings-redesign.md` §2):
 *
 *  1. **Settings edits sources; sessions show state.** Nothing here reads a live
 *     session value. The one session-shaped input is `engine` below, and it is
 *     used only to decide whether a project's FILES have been read at all.
 *  2. **Scope is chosen, never inherited.** The page's subject is an explicit
 *     pick — My defaults / a named project / This app / Enforced. Switching
 *     session tabs never changes it. So every selector here takes the scope as
 *     an argument; none of them derives it from whoever is focused.
 *  3. **Every write names its file before it happens.** The chosen scope decides
 *     the write layer (`selectSettingsWriteLayer`), full stop. The old
 *     `targetSourceFor` — write back to whichever layer the key happens to
 *     resolve at, so editing a value with a project override silently landed in
 *     that project's file — is deleted, not softened.
 *
 * Everything in here is pure and synchronous, because the renderer suite is
 * SSR-only (`renderToStaticMarkup`): no test in this package can press a key or
 * run an effect, so the decisions that matter live in selectors a test CAN call.
 * Same idiom as `settingsProjectBinding.ts` and `settingsReadState.ts`.
 *
 * ## What this module is allowed to know
 *
 * The snapshot it reads is one session's spawn-time read: the sidecar is spawned
 * in the session's cwd, so its project/local layers are THAT session's
 * (`app/sidecar/settingsDomain.ts:16-17`). Two consequences are load-bearing and
 * are encoded, not commented around:
 *
 *  - the **user layer is session-invariant**, so My defaults reads correctly
 *    from whichever session supplied the snapshot;
 *  - a **project layer is only about the session's own cwd**, so any other
 *    project must render the honest limit (`engine: 'absent'`) rather than
 *    values borrowed from a different project. The same rule blocks the WRITE,
 *    and there it is not merely cautious: the write verb is routed to the active
 *    session's sidecar, which writes ITS cwd's project file, so a write for a
 *    different project would land in the wrong file. Scope-addressed reads and
 *    per-project routing are the `settings.refresh` work (spec §6).
 *
 * The snapshot carries per-layer KEY NAMES (`layers[].keys`) but only the
 * WINNING layer's value (`editableValues[].source`). So "my user file sets this,
 * and a higher layer currently wins" is knowable, while the user file's own
 * value in that case is NOT — that is the `unreadable` read below, and it is
 * stated as unknown instead of being papered over with the resolved value.
 */

import type {
  SettingSourceId,
  SettingsSnapshot,
} from '../../shared/protocol.js'
import type {
  EditableSettingSource,
  EditableSettingValue,
} from '../../shared/settingsEditable.js'
import { SETTINGS_UNREAD_NOTE } from './settingsReadState.js'
import { selectEditableValue, selectLayerOrigin, SETTING_SOURCE_PRECEDENCE } from './settingsState.js'

/* ── scope ────────────────────────────────────────────────────────────────── */

export const SETTINGS_SCOPE_KINDS = [
  'user',
  'project',
  'app',
  'enforced',
] as const

export type SettingsScopeKind = (typeof SETTINGS_SCOPE_KINDS)[number]

export function isSettingsScopeKind(value: unknown): value is SettingsScopeKind {
  return (
    typeof value === 'string' &&
    (SETTINGS_SCOPE_KINDS as readonly string[]).includes(value)
  )
}

export const SETTINGS_SCOPE_LABEL: Record<SettingsScopeKind, string> = {
  user: 'My defaults',
  project: 'Project',
  app: 'This app',
  enforced: 'Enforced',
}

/** One sentence per scope, stating whose files (or non-files) it edits. */
export const SETTINGS_SCOPE_SUBTITLE: Record<SettingsScopeKind, string> = {
  user: 'Your own settings files. The same for every project on this machine.',
  project: "One project's settings files — shared with the repo, or private to you.",
  app: 'Desktop preferences. Stored by this app, never in a settings file.',
  enforced: 'What your organization enforces. Read-only, and it wins over everything.',
}

/** The two layers a project scope can write to (Law 3's one further choice). */
export const SETTINGS_PROJECT_LAYERS = [
  'projectSettings',
  'localSettings',
] as const

export type SettingsProjectLayer = (typeof SETTINGS_PROJECT_LAYERS)[number]

export const SETTINGS_PROJECT_LAYER_LABEL: Record<SettingsProjectLayer, string> =
  {
    projectSettings: 'Shared',
    localSettings: 'Just me',
  }

export const SETTINGS_PROJECT_LAYER_DESC: Record<SettingsProjectLayer, string> =
  {
    projectSettings:
      'Checked in with the repo, so everyone working on it gets these.',
    localSettings: 'Gitignored, so these stay on this machine and are yours.',
  }

/**
 * Law 3, as one function: the chosen scope decides the write layer. `null` for
 * the two scopes that write no settings file at all — This app (renderer-owned
 * preferences) and Enforced (policy, read-only by definition).
 */
export function selectSettingsWriteLayer(
  scope: SettingsScopeKind,
  projectLayer: SettingsProjectLayer,
): EditableSettingSource | null {
  switch (scope) {
    case 'user':
      return 'userSettings'
    case 'project':
      return projectLayer
    case 'app':
    case 'enforced':
      return null
    default: {
      const exhaustive: never = scope
      return exhaustive
    }
  }
}

/* ── project picker ───────────────────────────────────────────────────────── */

/** A project the picker can offer. Identity is the cwd; the name is derived. */
export type SettingsProjectOption = {
  readonly cwd: string
  readonly name: string
}

export type SettingsProjectChoice = SettingsProjectOption & {
  /** The focused session's project. Offered FIRST and labeled — never
   * auto-selected, because Law 2 makes selecting it an act. */
  readonly current: boolean
}

/** Last path segment, or the whole path when it has none. Used only when no
 * caller-supplied name exists; the full cwd is always rendered beside it. */
export function settingsProjectLabel(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, '')
  const segment = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return segment.length > 0 ? segment : trimmed
}

/** Trailing separators are not identity — `/a/b` and `/a/b/` are one project. */
export function normalizeProjectCwd(cwd: string): string {
  const trimmed = cwd.trim().replace(/\/+$/, '')
  return trimmed.length > 0 ? trimmed : cwd.trim()
}

/**
 * The picker's population: every project the app knows about, the focused
 * session's first and flagged `current`.
 *
 * `projects` is the merged workspace roster when App supplies it. Until then the
 * only project this screen can name is the focused session's own cwd, which is
 * ALSO the only project whose files this window can currently read or write
 * (see the module header) — so the shorter list is not a placeholder, it is the
 * exact set the v1 read/write path can serve.
 */
export function selectSettingsProjects(
  projects: readonly SettingsProjectOption[] | undefined,
  activeCwd: string | null,
): SettingsProjectChoice[] {
  const active =
    activeCwd && activeCwd.trim().length > 0
      ? normalizeProjectCwd(activeCwd)
      : null
  const seen = new Set<string>()
  const out: SettingsProjectChoice[] = []
  const push = (option: SettingsProjectOption): void => {
    const cwd = normalizeProjectCwd(option.cwd)
    if (cwd.length === 0 || seen.has(cwd)) return
    seen.add(cwd)
    out.push({ cwd, name: option.name, current: cwd === active })
  }

  if (active) {
    const known = (projects ?? []).find(
      option => normalizeProjectCwd(option.cwd) === active,
    )
    push({ cwd: active, name: known?.name ?? settingsProjectLabel(active) })
  }
  for (const option of projects ?? []) push(option)
  return out
}

/** Whether an engine is running IN the chosen project, i.e. whether this window
 * has read that project's settings files at all. */
export type SettingsProjectEngine = 'live' | 'absent'

/**
 * v1's honest limit, computed rather than assumed: the only project whose files
 * were read is the one the focused session's sidecar was spawned in.
 */
export function selectProjectEngine(
  projectCwd: string | null,
  activeCwd: string | null,
): SettingsProjectEngine {
  if (!projectCwd || !activeCwd) return 'absent'
  return normalizeProjectCwd(projectCwd) === normalizeProjectCwd(activeCwd)
    ? 'live'
    : 'absent'
}

export function settingsNoEngineNote(projectName: string): string {
  return (
    `No engine is running in ${projectName}, so its settings files have not ` +
    'been read. Open a session in that project to see and edit them.'
  )
}

/* ── rail ─────────────────────────────────────────────────────────────────── */

export const SETTINGS_RAIL_ITEM_IDS = [
  'general',
  'model',
  'permissions',
  'interface',
  'privacy',
  'memory',
  'agents',
  'skills',
  'plugins',
  'mcp',
  'hooks',
  'remote',
  'appearance',
  'notifications',
  'policy',
] as const

export type SettingsRailItemId = (typeof SETTINGS_RAIL_ITEM_IDS)[number]

export function isSettingsRailItemId(
  value: unknown,
): value is SettingsRailItemId {
  return (
    typeof value === 'string' &&
    (SETTINGS_RAIL_ITEM_IDS as readonly string[]).includes(value)
  )
}

export type SettingsRailItem = {
  readonly id: SettingsRailItemId
  readonly label: string
  readonly desc: string
  readonly locked?: true
}

/**
 * The rail is FUNCTIONAL — what a person came to change — because the resolver's
 * own vocabulary (user / project / local / flag / policy) is now the scope
 * selector above it and a per-row annotation beside it. It never structures the
 * nav again (spec §2, "provenance is an annotation, not an organizing axis").
 */
const RAIL_ITEMS: Record<SettingsRailItemId, SettingsRailItem> = {
  general: {
    id: 'general',
    label: 'General',
    desc: 'Update channel, git behavior, and workflow guidance',
  },
  model: {
    id: 'model',
    label: 'Model & Reasoning',
    desc: 'Effort, thinking, fast mode, and how reasoning is shown',
  },
  permissions: {
    id: 'permissions',
    label: 'Permissions',
    desc: 'The saved default mode and the rules new sessions start with',
  },
  interface: {
    id: 'interface',
    label: 'Interface',
    desc: 'Output style and syntax highlighting',
  },
  privacy: {
    id: 'privacy',
    label: 'Privacy & Data',
    desc: 'How long transcripts are kept',
  },
  memory: {
    id: 'memory',
    label: 'Memory',
    desc: 'CLAUDE.md instruction files and saved memories',
  },
  agents: {
    id: 'agents',
    label: 'Agents',
    desc: 'Agent definitions by source, with overrides and precedence',
  },
  skills: {
    id: 'skills',
    label: 'Skills',
    desc: 'Prompt-command skills, grouped by source',
  },
  plugins: {
    id: 'plugins',
    label: 'Plugins',
    desc: 'Installed plugins and the marketplace',
  },
  mcp: {
    id: 'mcp',
    label: 'MCP',
    desc: 'Configured Model Context Protocol servers',
  },
  hooks: {
    id: 'hooks',
    label: 'Hooks',
    desc: 'Event hooks by event, with recent run results',
  },
  remote: {
    id: 'remote',
    label: 'Remote',
    desc: 'Saved SSH environments and the Remote Control bridge',
  },
  appearance: {
    id: 'appearance',
    label: 'Appearance',
    desc: 'How this app draws the transcript',
  },
  notifications: {
    id: 'notifications',
    label: 'Notifications',
    desc: 'How this app tells you a turn finished',
  },
  policy: {
    id: 'policy',
    label: 'Enforced settings',
    desc: 'Settings your organization enforces',
    locked: true,
  },
}

export function settingsRailItem(id: SettingsRailItemId): SettingsRailItem {
  return RAIL_ITEMS[id]
}

export type SettingsRailGroup = {
  /** null = an unheaded block; the rail only earns a heading where one group
   * would otherwise be indistinguishable from the next (Extensions). */
  readonly heading: string | null
  readonly items: readonly SettingsRailItem[]
}

const CORE_ITEMS: readonly SettingsRailItemId[] = [
  'general',
  'model',
  'permissions',
  'interface',
  'privacy',
  'memory',
]

/** Operator ruling on spec §7.5: five rail items under an Extensions group. */
const EXTENSION_ITEMS: readonly SettingsRailItemId[] = [
  'agents',
  'skills',
  'plugins',
  'mcp',
  'hooks',
]

const RAIL: Record<
  SettingsScopeKind,
  readonly { heading: string | null; items: readonly SettingsRailItemId[] }[]
> = {
  user: [
    { heading: null, items: CORE_ITEMS },
    { heading: 'Extensions', items: EXTENSION_ITEMS },
    { heading: null, items: ['remote'] },
  ],
  // Remote is machine-level durable config (sshConfigs, default environment), so
  // it has no per-project meaning and is absent here rather than rendered empty.
  project: [
    { heading: null, items: CORE_ITEMS },
    { heading: 'Extensions', items: EXTENSION_ITEMS },
  ],
  app: [{ heading: null, items: ['appearance', 'notifications'] }],
  enforced: [{ heading: null, items: ['policy'] }],
}

/**
 * The rail for one scope, matched against the search box in the same pass.
 *
 * Exported because search is the one part of the rail the SSR-only suite cannot
 * drive (no events), and a filter that quietly stopped reaching the last group
 * would look identical in the markup. Groups emptied by the query drop out
 * entirely, so no heading is ever left standing over nothing.
 */
export function selectSettingsRail(
  scope: SettingsScopeKind,
  query: string,
): SettingsRailGroup[] {
  const q = query.trim().toLowerCase()
  return RAIL[scope]
    .map(group => ({
      heading: group.heading,
      items: group.items
        .map(id => RAIL_ITEMS[id])
        .filter(item => !q || item.label.toLowerCase().includes(q)),
    }))
    .filter(group => group.items.length > 0)
}

/**
 * Which rail item a scope shows. Switching scope keeps the operator on the same
 * functional pane when that scope has one (General stays General), and falls
 * back to the scope's first item when it does not (Remote → General, because
 * Remote is not a project-scoped pane).
 */
export function selectSettingsRailItem(
  scope: SettingsScopeKind,
  wanted: string,
): SettingsRailItemId {
  const available = RAIL[scope].flatMap(group => group.items)
  if (isSettingsRailItemId(wanted) && available.includes(wanted)) return wanted
  // Every scope's rail is non-empty by construction (see RAIL above).
  return available[0] as SettingsRailItemId
}

/* ── row grammar ──────────────────────────────────────────────────────────── */

/** What the row is allowed to DISPLAY as the current value. */
export type SettingsRowRead =
  /** No settings file has been read at all (`settingsReadState.ts`). */
  | { readonly kind: 'unread' }
  /** The chosen project has no engine, so its files have not been read. */
  | { readonly kind: 'no-engine' }
  /**
   * This layer sets the key, but a higher layer wins and the snapshot carries
   * only the winner's value — so this scope's own value is genuinely unknown and
   * is shown as such. `by` is null when the snapshot resolves the key but
   * carries no value for it at all (tolerant read of an older snapshot).
   */
  | {
      readonly kind: 'unreadable'
      readonly by: SettingSourceId | null
      readonly origin: string | null
    }
  /** A real value this scope can stand behind, plus the layer it came from. */
  | {
      readonly kind: 'set'
      readonly value: EditableSettingValue
      readonly source: SettingSourceId
    }
  /** Nothing sets it at or below this layer — the built-in default applies. */
  | { readonly kind: 'unset' }

/** The one annotation line, in the spec's priority order (§3, Row grammar). */
export type SettingsRowAnnotation =
  | { readonly kind: 'unread' }
  | { readonly kind: 'no-engine' }
  | { readonly kind: 'enforced'; readonly origin: string | null }
  | {
      readonly kind: 'overridden'
      readonly by: SettingSourceId
      readonly origin: string | null
    }
  | {
      readonly kind: 'inherited'
      readonly from: SettingSourceId
      readonly origin: string | null
    }
  | { readonly kind: 'set-here'; readonly origin: string | null }
  | { readonly kind: 'unset-here'; readonly origin: string | null }

export type SettingsRowModel = {
  readonly read: SettingsRowRead
  readonly annotation: SettingsRowAnnotation
  /** Where a click lands, or null when this row cannot be written in this
   * scope. Never derived from where the value currently resolves (Law 3). */
  readonly writeTarget: EditableSettingSource | null
}

/** Precedence rank, high → low; a SMALLER number wins. */
function rank(source: SettingSourceId): number {
  const index = SETTING_SOURCE_PRECEDENCE.indexOf(source)
  return index === -1 ? SETTING_SOURCE_PRECEDENCE.length : index
}

function layerDefines(
  snapshot: SettingsSnapshot,
  source: SettingSourceId,
  key: string,
): boolean {
  return snapshot.layers.some(
    layer => layer.source === source && layer.keys.includes(key),
  )
}

/**
 * One row's read + annotation + write target, for the chosen scope's `layer`.
 *
 * The branch order IS the spec's annotation priority: enforced → overridden →
 * set here → inherited → not set here.
 */
export function selectSettingsRow({
  snapshot,
  key,
  layer,
  engine = 'live',
}: {
  snapshot: SettingsSnapshot | null
  key: string
  layer: EditableSettingSource
  engine?: SettingsProjectEngine
}): SettingsRowModel {
  if (engine === 'absent') {
    return {
      read: { kind: 'no-engine' },
      annotation: { kind: 'no-engine' },
      writeTarget: null,
    }
  }
  if (!snapshot) {
    return {
      read: { kind: 'unread' },
      annotation: { kind: 'unread' },
      writeTarget: null,
    }
  }

  const winner = snapshot.resolved.find(entry => entry.key === key) ?? null
  const value = selectEditableValue(snapshot, key)

  if (winner?.managed) {
    const origin = selectLayerOrigin(snapshot, winner.source)
    return {
      read:
        value === null
          ? { kind: 'unreadable', by: null, origin }
          : { kind: 'set', value, source: winner.source },
      annotation: { kind: 'enforced', origin },
      writeTarget: null,
    }
  }

  if (winner && rank(winner.source) < rank(layer)) {
    // A higher layer wins. If THIS layer also sets the key, its own value is
    // hidden underneath and must not be guessed at; if it does not, this scope
    // genuinely contributes the built-in default and stays writable — Law 3's
    // "editing in My defaults while a project overrides it still writes the
    // user file, with an annotation".
    const origin = selectLayerOrigin(snapshot, winner.source)
    const definesHere = layerDefines(snapshot, layer, key)
    return {
      read: definesHere
        ? { kind: 'unreadable', by: winner.source, origin }
        : { kind: 'unset' },
      annotation: { kind: 'overridden', by: winner.source, origin },
      writeTarget: definesHere ? null : layer,
    }
  }

  if (winner && winner.source === layer) {
    const origin = selectLayerOrigin(snapshot, layer)
    return {
      read:
        value === null
          ? { kind: 'unreadable', by: null, origin }
          : { kind: 'set', value, source: layer },
      annotation: { kind: 'set-here', origin },
      writeTarget: layer,
    }
  }

  if (winner) {
    // A LOWER layer wins, which can only mean this layer does not set the key.
    // The value shown is what the scope resolves to; editing it is an override.
    const origin = selectLayerOrigin(snapshot, winner.source)
    return {
      read:
        value === null
          ? { kind: 'unreadable', by: null, origin }
          : { kind: 'set', value, source: winner.source },
      annotation: { kind: 'inherited', from: winner.source, origin },
      writeTarget: layer,
    }
  }

  return {
    read: { kind: 'unset' },
    annotation: {
      kind: 'unset-here',
      origin: selectLayerOrigin(snapshot, layer),
    },
    writeTarget: layer,
  }
}

/**
 * How each layer is NAMED inside a sentence. Deliberately not the badge
 * vocabulary (`SOURCE_LABEL`): a badge is a token, an annotation is prose, and
 * `flagSettings` in particular has to read as session state rather than as
 * another file the operator could go and edit.
 */
export const SETTINGS_LAYER_PHRASE: Record<SettingSourceId, string> = {
  userSettings: 'your defaults',
  projectSettings: "this project's shared settings",
  localSettings: 'your private settings for this project',
  flagSettings: 'a command-line flag on the open session',
  policySettings: 'organization policy',
}

function withOrigin(base: string, origin: string | null): string {
  return origin ? `${base} — ${origin}` : `${base}.`
}

export function settingsRowAnnotationText(
  annotation: SettingsRowAnnotation,
): string {
  switch (annotation.kind) {
    case 'unread':
      return SETTINGS_UNREAD_NOTE
    case 'no-engine':
      return 'Not read — no engine is running in this project'
    case 'enforced':
      return withOrigin(
        'Enforced by organization policy — see Enforced',
        annotation.origin,
      )
    case 'overridden':
      return withOrigin(
        `Overridden by ${SETTINGS_LAYER_PHRASE[annotation.by]}`,
        annotation.origin,
      )
    case 'inherited':
      return withOrigin(
        `Inherited from ${SETTINGS_LAYER_PHRASE[annotation.from]}`,
        annotation.origin,
      )
    case 'set-here':
      return withOrigin('Set here', annotation.origin)
    case 'unset-here':
      return 'Not set here — showing the built-in default.'
    default: {
      const exhaustive: never = annotation
      return exhaustive
    }
  }
}

/**
 * The single line a row renders. Folds in WHY an `unreadable` row shows nothing,
 * so a pane never has to re-derive that from the two fields itself.
 */
export function settingsRowNote(row: SettingsRowModel): string {
  const base = settingsRowAnnotationText(row.annotation)
  if (row.read.kind !== 'unreadable') return base
  // A path-terminated annotation carries no full stop of its own, so add one
  // before the follow-on sentence rather than running the two together.
  const stop = base.endsWith('.') ? '' : '.'
  return `${base}${stop} This app reads the resolved value only, so your own value here cannot be shown.`
}

/* ── write-target disclosure (Law 3, before the edit) ─────────────────────── */

/**
 * Because the SCOPE decides the target, the target is a property of the pane,
 * not of a row — so it is stated once, above the controls, instead of being
 * disclosed per row after the fact.
 */
export const SETTINGS_WRITE_TARGET_LABEL: Record<EditableSettingSource, string> =
  {
    userSettings: 'Edits here write to your own settings file',
    projectSettings: "Edits here write to this project's shared settings file",
    localSettings:
      'Edits here write to your private settings file for this project',
  }

export function settingsWriteTargetNote(
  layer: EditableSettingSource,
  origin: string | null,
): string {
  const label = SETTINGS_WRITE_TARGET_LABEL[layer]
  return origin
    ? `${label}: ${origin}`
    : `${label}. That file holds no settings yet; the first edit creates it.`
}

/** Said once, globally, instead of implied per row (spec §2's honesty rule). */
export const SETTINGS_APPLY_NOTE =
  'Settings are read when a session starts, so edits apply to sessions started afterwards — not to sessions already running.'

/**
 * Where the categories that left this page belong.
 *
 * Deliberately a statement about WHERE THEY BELONG, not a promise that the
 * inspector is already rendering them: `MetadataInspector` grew those sections
 * (CC-19a) but is still waiting on one `App.tsx` wiring line, and App is mid-edit
 * in another session. Saying "you'll find them there" would be the same class of
 * false claim this whole surface is being rebuilt to remove.
 */
export const SETTINGS_SESSION_STATE_NOTE =
  'Live session state — the running permission mode and context, workspace trust, IDE and LSP status, doctor output — is not configuration, so it is no longer here. Its home is the session inspector, from a tab’s ⋯ menu.'
