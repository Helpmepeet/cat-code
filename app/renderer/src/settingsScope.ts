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
  EditableSettingPane,
  EditableSettingSource,
  EditableSettingValue,
} from '../../shared/settingsEditable.js'
import { validateEditableSettingValue } from '../../shared/settingsEditable.js'
import { settingsUnreadNote } from './settingsReadState.js'
import { settingsPaneSpecs } from './settingsEditorModel.js'
import { selectLayerOrigin, SETTING_SOURCE_PRECEDENCE } from './settingsState.js'

/* ── scope ────────────────────────────────────────────────────────────────── */

export const SETTINGS_SCOPE_KINDS = [
  'user',
  'project',
  'app',
  'enforced',
] as const

export type SettingsScopeKind = (typeof SETTINGS_SCOPE_KINDS)[number]

export const SETTINGS_SCOPE_LABEL: Record<SettingsScopeKind, string> = {
  user: 'My defaults',
  project: 'Project',
  app: 'This app',
  enforced: 'Enforced',
}

/** One sentence per scope, stating whose files (or non-files) it edits. */
export const SETTINGS_SCOPE_SUBTITLE: Record<SettingsScopeKind, string> = {
  user: 'Your own settings files. The same for every project on this machine.',
  project:
    "One project's settings files, shared with the repo or private to you.",
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
    // There are no saved SSH environments, and there is no roster to save them
    // in: `decisions/PAIRED-DEVICES.md` §1-§3 cut the SSH connect mode and the
    // device roster, and `RemoteSettingsSnapshot` carries only `bridge` and
    // `commandFilter`. The rail now names the three things the pane actually
    // renders (`RemoteSettingsPage.tsx`): the bridge, its inbound command
    // filter, and the direct-connect form.
    label: 'Remote',
    desc: 'The Remote Control bridge, its command filter, and connecting a remote session',
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
 * Which editor pane each rail item hosts, for search. Items that render
 * `SettingsPane` appear; the rest carry no editable-setting rows, so a query can
 * only reach them through their own label and description.
 */
const RAIL_ITEM_PANE: Partial<Record<SettingsRailItemId, EditableSettingPane>> =
  {
    general: 'general',
    model: 'model',
    privacy: 'privacy',
    interface: 'theme',
    memory: 'memory',
  }

/**
 * What a query is matched against for one rail item: its own label and
 * description, plus the LABELS OF THE SETTINGS IT CONTAINS.
 *
 * Matching the category label alone made the box unusable for its actual job —
 * every real setting name ("Respect .gitignore", "Output style", "Transcript
 * retention") returned nothing, because none of them is a category. The setting
 * labels come from `settingsPaneSpecs`, i.e. the specs the pane will really
 * render, so search can never route to a pane that then does not show the row
 * the operator searched for.
 */
function railItemSearchText(item: SettingsRailItem): string {
  const pane = RAIL_ITEM_PANE[item.id]
  const settings = pane ? settingsPaneSpecs(pane).map(spec => spec.label) : []
  return [item.label, item.desc, ...settings].join(' ').toLowerCase()
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
        .filter(item => !q || railItemSearchText(item).includes(q)),
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
  /** `sessionOpen` picks between the two unread sentences — a running session
   * whose files were never read must not be told no session is open. */
  | { readonly kind: 'unread'; readonly sessionOpen: boolean }
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
  /**
   * Whether the CHOSEN layer's own file carries this key — i.e. whether there is
   * anything here to REMOVE (P4-41, the reset affordance's precondition).
   *
   * Deliberately not "the value differs from the built-in default", which is what
   * the prototype's `modified={g.key !== DEF.key}` means. Our reset removes the
   * key rather than writing the default back, so the question that decides
   * whether it can do anything is whether this layer sets the key at all. The two
   * differ in both directions: a key pinned AT its default is removable, and a
   * value that differs from the default only because a lower layer supplies it is
   * not this layer's to remove.
   *
   * Carried on the model rather than re-derived from `read`/`annotation` by each
   * caller, because the overridden case makes those ambiguous: an overridden row
   * that this layer does set reads `unreadable` for a reason unrelated to whether
   * the key is present.
   */
  readonly definesHere: boolean
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
 * ONE layer's own value for a key, or null when the snapshot carries no value
 * attributed to that layer.
 *
 * `selectEditableValue` answers "what does this key resolve to", which is the
 * WINNER's value. This answers "what does MY scope's file say", which is a
 * different question and the only one an overridden row may show. It returns
 * null wherever the snapshot only carries the winner, so the row falls back to
 * stating the value as unknown rather than borrowing another layer's.
 */
function layerValue(
  snapshot: SettingsSnapshot,
  source: SettingSourceId,
  key: string,
): EditableSettingValue | null {
  return (
    (snapshot.editableValues ?? []).find(
      entry => entry.key === key && entry.source === source,
    )?.value ?? null
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
  sessionOpen = false,
}: {
  snapshot: SettingsSnapshot | null
  key: string
  layer: EditableSettingSource
  engine?: SettingsProjectEngine
  /** Whether a session is attached at all, which the shell knows from its cwd.
   * Only ever changes the WORDING of the unread case. */
  sessionOpen?: boolean
}): SettingsRowModel {
  if (engine === 'absent') {
    return {
      read: { kind: 'no-engine' },
      annotation: { kind: 'no-engine' },
      writeTarget: null,
      definesHere: false,
    }
  }
  if (!snapshot) {
    return {
      read: { kind: 'unread' },
      annotation: { kind: 'unread', sessionOpen },
      writeTarget: null,
      definesHere: false,
    }
  }

  const winner = snapshot.resolved.find(entry => entry.key === key) ?? null

  if (winner?.managed) {
    const origin = selectLayerOrigin(snapshot, winner.source)
    // The winning layer's OWN value, never a lower layer's borrowed via a
    // source-blind lookup (that was the bug: a value the sidecar's per-key
    // validator dropped for this layer fell through to whichever layer's value
    // happened to exist, and the row attributed it to the winner regardless).
    const value = layerValue(snapshot, winner.source, key)
    return {
      read:
        value === null
          ? { kind: 'unreadable', by: null, origin }
          : { kind: 'set', value, source: winner.source },
      annotation: { kind: 'enforced', origin },
      writeTarget: null,
      // Policy is never a write target, so a policy-managed row has nothing this
      // scope could remove even when the user file also sets the key.
      definesHere: false,
    }
  }

  if (winner && rank(winner.source) < rank(layer)) {
    // A higher layer wins. This scope's own value is shown when the snapshot
    // attributes one to this layer, and stated as unknown when it does not —
    // never guessed at from the winner.
    //
    // The write target is THIS LAYER either way (Law 3: "editing in My defaults
    // while a project overrides it still writes the user file, with an
    // annotation"). Making it null once the layer defines the key was a trap
    // that sprang on the operator's own edit: writing an overridden row is what
    // makes `definesHere` true, so the very next snapshot turned the control
    // they had just used into an unwritable, unreadable row with no way back.
    const origin = selectLayerOrigin(snapshot, winner.source)
    const definesHere = layerDefines(snapshot, layer, key)
    const own = definesHere ? layerValue(snapshot, layer, key) : null
    return {
      read: !definesHere
        ? { kind: 'unset' }
        : own === null
          ? { kind: 'unreadable', by: winner.source, origin }
          : { kind: 'set', value: own, source: layer },
      annotation: { kind: 'overridden', by: winner.source, origin },
      writeTarget: layer,
      definesHere,
    }
  }

  if (winner && winner.source === layer) {
    const origin = selectLayerOrigin(snapshot, layer)
    // Source-scoped, not the blind winner lookup: this layer IS the winner, but
    // its own stored value can still be missing when the sidecar's per-key
    // validator dropped it, and a blind key-only lookup would then borrow a
    // lower layer's value and attribute it to this one.
    const value = layerValue(snapshot, layer, key)
    return {
      read:
        value === null
          ? { kind: 'unreadable', by: null, origin }
          : { kind: 'set', value, source: layer },
      annotation: { kind: 'set-here', origin },
      writeTarget: layer,
      definesHere: true,
    }
  }

  if (winner) {
    // A LOWER layer wins, which can only mean this layer does not set the key.
    // The value shown is what the scope resolves to; editing it is an override.
    const origin = selectLayerOrigin(snapshot, winner.source)
    // The winning (lower) layer's OWN value, not a blind key-only lookup that
    // could borrow yet another layer's value the sidecar's validator kept.
    const value = layerValue(snapshot, winner.source, key)
    return {
      read:
        value === null
          ? { kind: 'unreadable', by: null, origin }
          : { kind: 'set', value, source: winner.source },
      annotation: { kind: 'inherited', from: winner.source, origin },
      writeTarget: layer,
      // A LOWER layer wins, which can only mean this layer does not set the key.
      definesHere: false,
    }
  }

  return {
    read: { kind: 'unset' },
    annotation: {
      kind: 'unset-here',
      origin: selectLayerOrigin(snapshot, layer),
    },
    writeTarget: layer,
    definesHere: false,
  }
}

/**
 * The Permissions pane's "Default mode" row, in the CHOSEN scope.
 *
 * `permissions.defaultMode` is nested, so the sidecar resolves it on its own
 * axis and the snapshot carries only the winning layer's value — it never
 * appears in `resolved`/`layers[].keys` and so cannot go through
 * `selectSettingsRow`. Reading `permissionDefaultMode` straight, as this pane
 * did, produced the one row on the page that ignored the scope: a project's
 * `acceptEdits` rendered under a head reading "Your own settings files", and the
 * follow-on "is not set in any settings file" was asserted from a cross-scope
 * read.
 *
 * So the same row grammar is applied to it here. `writeTarget` is always null:
 * making the default writable means adding a permission-family key to the
 * sidecar's write allowlist, which needs its own review (spec §7.1).
 */
export function selectPermissionDefaultModeRow({
  snapshot,
  layer,
  engine = 'live',
  sessionOpen = false,
}: {
  snapshot: SettingsSnapshot | null
  layer: EditableSettingSource
  engine?: SettingsProjectEngine
  sessionOpen?: boolean
}): SettingsRowModel {
  if (engine === 'absent') {
    return {
      read: { kind: 'no-engine' },
      annotation: { kind: 'no-engine' },
      writeTarget: null,
      definesHere: false,
    }
  }
  if (!snapshot) {
    return {
      read: { kind: 'unread' },
      annotation: { kind: 'unread', sessionOpen },
      writeTarget: null,
      definesHere: false,
    }
  }

  const winner = snapshot.permissionDefaultMode ?? null
  if (!winner) {
    return {
      read: { kind: 'unset' },
      annotation: {
        kind: 'unset-here',
        origin: selectLayerOrigin(snapshot, layer),
      },
      writeTarget: null,
      definesHere: false,
    }
  }

  const origin = selectLayerOrigin(snapshot, winner.source)
  if (winner.source === 'policySettings') {
    return {
      read: { kind: 'set', value: winner.value, source: winner.source },
      annotation: { kind: 'enforced', origin },
      writeTarget: null,
      definesHere: false,
    }
  }
  if (winner.source === layer) {
    return {
      read: { kind: 'set', value: winner.value, source: layer },
      annotation: { kind: 'set-here', origin },
      writeTarget: null,
      // The layer does set it, but `permissions.defaultMode` is not in the write
      // allowlist, so nothing here can act on that (spec §7.1).
      definesHere: true,
    }
  }
  if (rank(winner.source) < rank(layer)) {
    // A higher layer wins, and the snapshot carries no per-layer default mode,
    // so this scope's own value is genuinely unknown.
    return {
      read: { kind: 'unreadable', by: winner.source, origin },
      annotation: { kind: 'overridden', by: winner.source, origin },
      writeTarget: null,
      // The snapshot carries no per-layer default mode, so whether this layer
      // sets it is genuinely unknown — stated as "no", never guessed.
      definesHere: false,
    }
  }
  return {
    read: { kind: 'set', value: winner.value, source: winner.source },
    annotation: { kind: 'inherited', from: winner.source, origin },
    writeTarget: null,
    definesHere: false,
  }
}

/**
 * What a "Reset to default" click sends, or null when the row has nothing to
 * remove and the affordance must not be offered at all (P4-41).
 *
 * The precondition and the payload are decided in ONE place so they cannot drift
 * apart — a button that appears under one rule and writes under another is the
 * shape of the bug this session exists to remove. It is a selector rather than
 * an inline closure because this package renders SSR-only, so a handler is the
 * one thing no test here can press.
 *
 * `value: null` is the REMOVE request, never a write of the built-in default:
 * pinning a key at its default is a real state, and reset's job is to un-pin it.
 * `writeTarget` is already the chosen scope's layer (Law 3) and is null for every
 * read-only row, so this can only ever name one of the three editable layers.
 */
export function selectSettingsReset(
  row: SettingsRowModel,
  key: string,
): { source: EditableSettingSource; key: string; value: null } | null {
  if (!row.definesHere || row.writeTarget === null) return null
  return { source: row.writeTarget, key, value: null }
}

/**
 * Whether a control must send its value even when that value equals the one
 * already on screen.
 *
 * True exactly for a writable UNSET row, because what such a row displays is the
 * BUILT-IN DEFAULT, not something any file holds. "Same as displayed" therefore
 * does not mean "already saved", and the ordinary no-change guards silently ate
 * the one edit that matters here: pinning a setting at its current value in your
 * own file so a later change elsewhere cannot move it. The operator typed the
 * number, blurred, nothing was sent, and the row went on saying the built-in
 * default applies.
 */
export function settingsRowCommitsUnchanged(row: SettingsRowModel): boolean {
  return row.read.kind === 'unset' && row.writeTarget !== null
}

/* ── destructive values ───────────────────────────────────────────────────── */

/**
 * A value inside a key's legal domain that DESTROYS data once it takes effect.
 *
 * Declared per KEY, never branched on inside a control. `IntField` is generic
 * over every int key, so a `key === '…'` test in it would make one shared
 * control carry one key's engine semantics, and the next destructive value
 * would add a second branch rather than a second declaration.
 *
 * The home is the renderer rather than `app/shared/settingsEditable.ts` for two
 * reasons. That module is the SIDECAR's validation boundary, and nothing here
 * changes what may be written — `0` is and stays an ordinary member of
 * `{ kind: 'int', min: 0, max: 3650 }` — so leaving it untouched IS the proof
 * that the boundary is unchanged. And every string below is user-visible copy,
 * which the §7 sweep (`userVisibleText.test.ts`) reads over `renderer/src` and
 * not over `app/shared`.
 */
export type SettingsDestructiveChoice = {
  /** The exact value this declaration is about. */
  readonly value: EditableSettingValue
  readonly title: string
  /** What committing it does. */
  readonly body: string
  /** What can still be done about it. */
  readonly remedy: string
  readonly confirmLabel: string
  readonly cancelLabel: string
  /** Kept on the row for as long as the value is the one in effect. */
  readonly rowWarning: string
}

/**
 * `cleanupPeriodDays: 0` is the only one today, and it is not a "stop keeping
 * new ones" switch. It suppresses every transcript write
 * (`src/utils/sessionStorage.ts:1408`, `shouldSkipPersistence`) AND makes the
 * retention cutoff `now` (`src/utils/cleanup.ts:24-31`, `getCutoffDate`), so the
 * housekeeping sweep unlinks every stored transcript
 * (`cleanupOldSessionFiles`, `src/utils/cleanup.ts:151`).
 *
 * The settings write suppresses new transcript persistence immediately. Existing
 * transcripts remain until the engine's existing background-housekeeping path
 * runs its leased cleanup; the renderer-authorized settings verb does not start
 * deletion itself.
 */
const DESTRUCTIVE_SETTING_VALUES: Readonly<
  Record<string, SettingsDestructiveChoice>
> = {
  cleanupPeriodDays: {
    value: 0,
    title: 'Delete every saved session?',
    body:
      'Keeping transcripts for 0 days immediately stops this app saving new ' +
      'sessions. Existing saved sessions are deleted later by background cleanup, ' +
      'and that deletion cannot be undone.',
    remedy:
      'Set the number back above 0 before cleanup runs to keep sessions that are still saved.',
    confirmLabel: 'Delete saved sessions',
    cancelLabel: 'Cancel',
    rowWarning:
      'Every saved session will be deleted, and new ones are not kept. Set ' +
      'this above 0 to keep them.',
  },
}

/** The declaration for `value` on `key`, or null when it is an ordinary value. */
export function selectSettingsDestructiveChoice(
  key: string,
  value: EditableSettingValue,
): SettingsDestructiveChoice | null {
  const declared = DESTRUCTIVE_SETTING_VALUES[key]
  return declared && declared.value === value ? declared : null
}

/**
 * The warning a row keeps for as long as a destructive value is the one IN
 * EFFECT, or null.
 *
 * Deliberately NOT folded into `settingsRowNote`. That function's subject is
 * provenance — what contradicts the scope the operator chose — and it returns
 * null for the ordinary `set-here` case, which is exactly the case a saved `0`
 * lands in. A data-loss warning must not be suppressed by a provenance rule,
 * and it answers a different question, so it gets its own sentence in its own
 * slot.
 */
export function selectSettingsDestructiveWarning(
  row: SettingsRowModel,
  key: string,
): string | null {
  // `overridden` is the one `set` read whose value is NOT in effect: it carries
  // THIS layer's own value while a higher layer wins (`selectSettingsRow`), so
  // warning on it would promise a deletion that is not going to happen.
  if (row.read.kind !== 'set' || row.annotation.kind === 'overridden') {
    return null
  }
  return selectSettingsDestructiveChoice(key, row.read.value)?.rowWarning ?? null
}

/**
 * What one commit attempt on a validated int field must DO.
 *
 * ONE decision for BOTH triggers. The field commits on blur and on Enter, and a
 * destructive value has to be gated on both, so the choice cannot live in either
 * handler without the other being a hole. Pure, because this package renders
 * SSR-only and no test here can press either one.
 */
export type SettingsIntCommit =
  | { kind: 'invalid'; error: string }
  | { kind: 'unchanged' }
  | { kind: 'confirm'; value: number; choice: SettingsDestructiveChoice }
  | { kind: 'write'; value: number }

export function selectSettingsIntCommit({
  key,
  draft,
  current,
  commitUnchanged,
}: {
  key: string
  draft: string
  current: number
  /** Send the value even when it equals what is displayed. True for an unset
   * row, whose displayed value is the built-in default rather than a saved one,
   * so re-typing it IS a change to the file (`settingsRowCommitsUnchanged`). */
  commitUnchanged: boolean
}): SettingsIntCommit {
  // `Number('')` and `Number('   ')` are both `0`, so an emptied field would
  // otherwise commit as a typed zero with no way to tell the two apart.
  if (draft.trim().length === 0) {
    return { kind: 'invalid', error: 'Enter a number.' }
  }
  const validation = validateEditableSettingValue(key, Number(draft.trim()))
  if (!validation.ok) return { kind: 'invalid', error: validation.error }
  const value = validation.value as number
  if (!commitUnchanged && value === current) return { kind: 'unchanged' }
  const choice = selectSettingsDestructiveChoice(key, value)
  return choice ? { kind: 'confirm', value, choice } : { kind: 'write', value }
}

/**
 * What a cancelled confirmation puts back in the field: the value still in
 * effect, never the one that was about to be committed. Leaving the typed value
 * on screen after a cancel is its own bug — the field would go on showing a
 * number nobody saved, and the next blur would re-ask.
 */
export function settingsIntCancelDraft(current: number): string {
  return String(current)
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
  return origin ? `${base}: ${origin}` : `${base}.`
}

export function settingsRowAnnotationText(
  annotation: SettingsRowAnnotation,
): string {
  switch (annotation.kind) {
    case 'unread':
      return settingsUnreadNote(annotation.sessionOpen)
    case 'no-engine':
      return 'Not read, because no engine is running in this project'
    case 'enforced':
      return withOrigin('Enforced by organization policy', annotation.origin)
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
      return 'Not set here, showing the built-in default.'
    default: {
      const exhaustive: never = annotation
      return exhaustive
    }
  }
}

/**
 * The line a row renders, or null when the row has nothing surprising to say.
 *
 * `set-here` / `unset-here` ARE the ordinary outcome of the scope the operator
 * chose, so spelling them out on every row is noise the page already carries at
 * its head ("Edits here write to …") and in the row's own SourceBadge. Prose is
 * spent only on the cases that contradict the chosen scope: policy enforcement,
 * a higher layer winning, a value inherited from elsewhere, an unread snapshot,
 * or a value this app cannot show.
 */
export function settingsRowNote(row: SettingsRowModel): string | null {
  const ordinary =
    row.annotation.kind === 'set-here' || row.annotation.kind === 'unset-here'
  if (ordinary && row.read.kind !== 'unreadable') return null
  const base = settingsRowAnnotationText(row.annotation)
  if (row.read.kind !== 'unreadable') return base
  // A path-terminated annotation carries no full stop of its own, so add one
  // before the follow-on sentence rather than running the two together.
  const stop = base.endsWith('.') ? '' : '.'
  // `set-here` + unreadable means THIS layer is the winner and does set the
  // key, but its own stored value fell outside what the setting allows, so the
  // reason is the value, not a resolved-value-only limitation (the other
  // annotations reaching this branch are genuinely about a layer this app never
  // reads at all).
  if (row.annotation.kind === 'set-here') {
    return `${base}${stop} The saved value here doesn't fit what this setting allows, so it cannot be shown. Enter a new value to replace it.`
  }
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
  'Edits apply to sessions started afterwards, not to sessions already running.'

export function settingsApplyNote(item: SettingsRailItemId): string {
  return item === 'privacy'
    ? 'Stopping new session saves takes effect immediately. Existing saved sessions are deleted later by background cleanup. Other edits apply to sessions started afterwards.'
    : SETTINGS_APPLY_NOTE
}

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
  'Live session state is not configuration. Its home is the session inspector, from a tab’s ⋯ menu.'
