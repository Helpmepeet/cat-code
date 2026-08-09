/**
 * CC-19 §4 — the session inspector's LIVE-STATE core.
 *
 * The Settings redesign (`docs/migration/specs/2026-07-27-settings-redesign.md`)
 * splits settings-shaped information by Law 1: *Settings edits sources; sessions
 * show state*. Everything present-tense — what THIS session resolved, the live
 * permission context, the trust of its cwd, its extra directories, the engine's
 * doctor output, the flag layer — is a fact about a running process, so it leaves
 * Settings and lands on `MetadataInspector`. This module is the pure half of that
 * destination: the drawer renders, these selectors decide.
 *
 * Two rules it exists to enforce, both inherited with the data:
 *
 *  - **`settingsReadState.ts` doctrine.** A pane may not assert a fact it has not
 *    read, and "empty" ≠ "unread". Here the distinction is THREE-valued, because
 *    the drawer can also have been handed nothing at all: `unwired` (App passes
 *    no `sessionState` — the drawer has been TOLD nothing), `unread` (wired, but
 *    no snapshot exists for this session), `read` (a snapshot arrived, so an
 *    empty result is a real answer). The inspector's sections make the narrow
 *    render-time distinction they need, and none of the notes is phrased as
 *    "waiting…", since with a dead/never-attached session nothing is in flight
 *    and nothing will arrive.
 *  - **No fact is invented to fill a gap.** Where the wire carries no answer
 *    (IDE/LSP state; whether an extra directory is durable or ephemeral; the
 *    session's launch argv) the selector reports the gap and the drawer states
 *    it, citing the source that causes it.
 *
 * NOTHING here crosses the wire: every input is a snapshot the renderer already
 * holds for the active session (`settingsState.ts`, `permissionState.ts`,
 * `workspaceTrustState.ts`, `diagnosticsState.ts`), which is why hosting the
 * moved-out Settings panes needs no protocol change (§8.10 — reuse the real
 * seam, never a second one).
 */

import type {
  DiagnosticsSnapshot,
  PermissionContextSnapshot,
  RunControlsSnapshot,
  SettingSourceId,
  SettingsSnapshot,
  WorkspaceTrustSnapshot,
} from '../../shared/protocol.js'
import type { EditableSettingValue } from '../../shared/settingsEditable.js'
import { SETTING_SOURCE_PRECEDENCE } from './settingsState.js'

/* ------------------------------------------------------------------------- *
 * The bundle App hands the drawer
 * ------------------------------------------------------------------------- */

/**
 * Every live seam the inspector reads, for ONE session, in one value.
 *
 * One bundle rather than five sibling props on purpose: unwired, the drawer then
 * makes ONE honest statement instead of repeating the same sentence five times
 * — and App's later wiring is a single prop (`buildSessionInspectorState({…})`,
 * the `buildSessionMetadataView` idiom directly above it in `App.tsx`).
 *
 * Each field is nullable INDEPENDENTLY of the bundle: a wired drawer whose
 * session has no `diagnostics.snapshot` yet is a different state from an unwired
 * one, and the two must not collapse.
 */
export type SessionInspectorState = {
  /** The session's workspace root, from the host roster (never re-derived here). */
  readonly cwd: string | null
  readonly settings: SettingsSnapshot | null
  readonly permissionContext: PermissionContextSnapshot | null
  readonly workspaceTrust: WorkspaceTrustSnapshot | null
  readonly diagnostics: DiagnosticsSnapshot | null
  /**
   * The LIVE run-controls seam (P4-24c), re-broadcast on every model/effort/fast
   * change. It exists here because `diagnostics` is spawn-frozen, so the run
   * controls below cannot honour their own "values in effect now" promise from it
   * alone once the picker moves the model.
   */
  readonly runControls: RunControlsSnapshot | null
}

/** Assemble the bundle from the selectors App already calls (no new feed). */
export function buildSessionInspectorState(input: {
  cwd: string | null
  settings: SettingsSnapshot | null
  permissionContext: PermissionContextSnapshot | null
  workspaceTrust: WorkspaceTrustSnapshot | null
  diagnostics: DiagnosticsSnapshot | null
  runControls: RunControlsSnapshot | null
}): SessionInspectorState {
  return {
    cwd: input.cwd,
    settings: input.settings,
    permissionContext: input.permissionContext,
    workspaceTrust: input.workspaceTrust,
    diagnostics: input.diagnostics,
    runControls: input.runControls,
  }
}

/**
 * The seams whose absence the drawer must explain. A `Record` over this union
 * below, so adding a seam without writing its sentence is a compile error —
 * the `SETTINGS_PROJECT_UNBOUND_NOTE` idiom.
 */
export type InspectorSeamId =
  | 'settings'
  | 'permission'
  | 'workspaceTrust'
  | 'diagnostics'

/**
 * Why one seam has nothing to show, for a WIRED drawer.
 *
 * These deliberately do NOT name the frame that failed to arrive. The earlier
 * copy did, on the theory that naming it made the note diagnosable, but a frame
 * name is an engineering note and CLAUDE.md §7 forbids rendering one at the
 * user; `userVisibleText.test.ts` now enforces that repo-wide. Each states the
 * CONDITION under which the data exists instead, which is both true and
 * actionable. None promises that something is coming: this data is read while a
 * session is open, so one that never attached (or has died) will never have it.
 */
export const INSPECTOR_SEAM_UNREAD_NOTE: Readonly<
  Record<InspectorSeamId, string>
> = {
  settings:
    'Settings are unavailable for this session. They load while the session is open.',
  permission:
    'Permission mode and rules are unavailable for this session. They load while the session is open.',
  workspaceTrust:
    'Trust state is unavailable for this session. It loads while the session is open.',
  diagnostics:
    'Diagnostics are unavailable for this session. They load while the session is open.',
}

/**
 * The single line an UNWIRED drawer shows in place of every live section.
 *
 * It says what to do instead, and nothing about why. The copy it replaced named
 * a module and a prop and explained our own wiring gap — the class of rendered
 * engineering note the operator rejected outright on 2026-07-27 (CLAUDE.md §7).
 * A deviation belongs in a report, never on the page.
 */
export const INSPECTOR_UNWIRED_NOTE =
  'See these from the CLI with /doctor and /permissions.'

/* ------------------------------------------------------------------------- *
 * Effective settings — what THIS session resolved
 * ------------------------------------------------------------------------- */

export type SettingsLayerView = {
  readonly source: SettingSourceId
  readonly origin: string
  readonly keyCount: number
}

/**
 * The session's enabled settings layers, HIGHEST precedence first — the reverse
 * of the snapshot's ascending order, matching `SETTING_SOURCE_PRECEDENCE` (which
 * is reused, never re-declared). Empty when no settings file exists at any
 * layer, which is a real answer once a snapshot has been read.
 */
export function selectSettingsLayerViews(
  snapshot: SettingsSnapshot | null,
): readonly SettingsLayerView[] {
  if (!snapshot) return []
  return [...snapshot.layers]
    .sort(
      (a, b) =>
        SETTING_SOURCE_PRECEDENCE.indexOf(a.source) -
        SETTING_SOURCE_PRECEDENCE.indexOf(b.source),
    )
    .map(layer => ({
      source: layer.source,
      origin: layer.origin,
      keyCount: layer.keys.length,
    }))
}

export type EffectiveSettingRow = {
  readonly key: string
  /** The layer that WON this key for this session. */
  readonly source: SettingSourceId
  readonly managed: boolean
  readonly editable: boolean
  /**
   * The effective value — ONLY for keys in the P4-19 editable allowlist, which is
   * the only part of the seam that carries values at all (`SettingsSnapshot`
   * deliberately ships the source model, not the settings object, so no
   * credential-bearing value ever serializes). `null` therefore means "this seam
   * carries no value for this key", NEVER "empty" or "false" — the drawer must
   * render it as an absence, not as a value.
   */
  readonly value: EditableSettingValue | null
}

/**
 * Every top-level key this session resolved, with its winning layer and (where
 * the seam carries one) its value. Sorted by key so the list is stable across
 * re-renders and snapshots.
 */
export function selectEffectiveSettingRows(
  snapshot: SettingsSnapshot | null,
): readonly EffectiveSettingRow[] {
  if (!snapshot) return []
  const values = new Map(
    (snapshot.editableValues ?? []).map(entry => [entry.key, entry.value]),
  )
  return [...snapshot.resolved]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(resolution => ({
      key: resolution.key,
      source: resolution.source,
      managed: resolution.managed,
      editable: resolution.editable,
      value: values.get(resolution.key) ?? null,
    }))
}

/** How many resolved keys carry a value on this seam (the rest are name-only). */
export function selectValuedSettingCount(
  rows: readonly EffectiveSettingRow[],
): number {
  return rows.filter(row => row.value !== null).length
}

/* ------------------------------------------------------------------------- *
 * The flag layer + run controls
 * ------------------------------------------------------------------------- */

export type FlagLayerView = {
  /** The `--settings` file (or SDK inline-settings descriptor) backing the layer. */
  readonly origin: string
  /** Top-level keys the flag layer sets. */
  readonly keys: readonly string[]
  /** The subset it actually WINS — a policy layer still outranks it. */
  readonly winningKeys: readonly string[]
}

/**
 * The session's flag layer, or null when it has none.
 *
 * The flag layer is NOT "the CLI flags this session was started with": engine-
 * side it is exactly `--settings <file>` plus SDK inline settings
 * (`src/utils/settings/settings.ts:249,293,353-354`). Every other launch flag is
 * consumed at bootstrap and never re-surfaces as a settings layer, so it cannot
 * appear here — and no other frame carries the session's argv either.
 *
 * For a DESKTOP session it is emptier still: the app spawns each sidecar as
 * `bun run <sidecarEntry>` with no engine arguments at all
 * (`app/main/main.ts:477`), so a desktop session has no flag layer unless the
 * engine picks one up from the environment. The drawer says so rather than
 * implying a launch-flag story the wire cannot support.
 */
export function selectFlagLayer(
  snapshot: SettingsSnapshot | null,
): FlagLayerView | null {
  if (!snapshot) return null
  const layer = snapshot.layers.find(entry => entry.source === 'flagSettings')
  if (!layer) return null
  return {
    origin: layer.origin,
    keys: layer.keys,
    winningKeys: snapshot.resolved
      .filter(resolution => resolution.source === 'flagSettings')
      .map(resolution => resolution.key),
  }
}

export type RunControlsView = {
  /**
   * The engine's model OVERRIDE: "alias, full name (as with --model or env var),
   * or null (default)" (`src/state/AppStateStore.ts:503`). Mutable in-session:
   * the desktop's model picker writes the same field
   * (`app/sidecar/runControlsDomain.ts:124`), so this is the override IN EFFECT,
   * not proof of a launch flag. Read from the live seam
   * (`RunControlsSnapshot.model.selected`), which spells it as the matching
   * picker option when the setting and the option are two spellings of one model.
   */
  readonly modelOverride: string | null
  /** The model the session actually runs (`getMainLoopModel()` resolution). */
  readonly resolvedModel: string | null
  /** Explicit reasoning-effort tier, or null = the provider default (not a label). */
  readonly effort: string | null
  readonly fastMode: boolean
}

export function selectRunControls(
  diagnostics: DiagnosticsSnapshot | null,
  runControls: RunControlsSnapshot | null,
): RunControlsView | null {
  // The live seam wins WHOLE, never field by field, because its nulls are
  // ANSWERS rather than gaps: `model.selected: null` MEANS this session runs the
  // provider default, and `effort.current: null` means the current model takes no
  // effort knob at all. Borrowing the spawn-time value for either one prints a
  // fact the session no longer has, which is the same staleness this pair exists
  // to avoid. The two are not interchangeable per field either — live `effort`
  // is the APPLIED tier, the frozen one is the raw selection.
  if (runControls) {
    return {
      modelOverride: runControls.model.selected,
      resolvedModel: runControls.model.current,
      effort: runControls.effort.current,
      fastMode: runControls.fast.active,
    }
  }
  if (!diagnostics) return null
  return {
    modelOverride: diagnostics.mainLoopModel,
    resolvedModel: diagnostics.mainLoopModelForSession,
    effort: diagnostics.reasoningEffort,
    fastMode: diagnostics.fastMode,
  }
}

/**
 * Why the drawer can never say "this session was started with `--model …`". The
 * app records no launch argv for a session (`SessionDescriptor`,
 * `app/shared/hostApi.ts:68`, carries none) and the desktop passes the engine no
 * arguments to begin with (`app/main/main.ts:477`), so the run controls above are
 * the values IN EFFECT, not a launch record.
 */
export const LAUNCH_FLAGS_UNAVAILABLE_NOTE =
  'These are the values in effect now, not a record of how the session was launched. Changing the model mid-session rewrites the same field.'

/* ------------------------------------------------------------------------- *
 * This session's extra directories
 * ------------------------------------------------------------------------- */

export type SessionDirectoryGroup = {
  /** The engine's `PermissionRuleSource` tag, verbatim — never re-derived. */
  readonly source: string
  readonly count: number
}

export type SessionDirectoriesView = {
  readonly total: number
  readonly groups: readonly SessionDirectoryGroup[]
  /**
   * True when at least one entry is tagged `cliArg`, which is the known engine
   * defect this drawer must render honestly rather than paper over: a DURABLE
   * `permissions.additionalDirectories` entry and an EPHEMERAL `--add-dir` are
   * merged into one list and both tagged `destination: 'cliArg'`
   * (`src/utils/permissions/permissionSetup.ts:1015-1035`). So while this flag is
   * set, the split the redesign wants (durable in Settings / this-session extras
   * here) cannot be made from the wire — it needs the engine tag fix first.
   */
  readonly cliArgAmbiguous: boolean
}

/**
 * The session's additional working directories, counted per source tag. Counts
 * rather than paths: the authoritative path list is rendered once, by the live
 * permission-context view, and a second copy in the same drawer would be two
 * places to disagree.
 */
export function selectSessionDirectories(
  context: PermissionContextSnapshot | null,
): SessionDirectoriesView {
  const entries = context?.additionalWorkingDirectories ?? []
  const counts = new Map<string, number>()
  for (const entry of entries) {
    counts.set(entry.source, (counts.get(entry.source) ?? 0) + 1)
  }
  return {
    total: entries.length,
    groups: [...counts.entries()]
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => a.source.localeCompare(b.source)),
    cliArgAmbiguous: entries.some(entry => entry.source === 'cliArg'),
  }
}

/**
 * The limit the drawer prints whenever `cliArgAmbiguous` holds.
 *
 * The evidence, which used to be printed ON SCREEN: a durable
 * `permissions.additionalDirectories` entry and an ephemeral `--add-dir` are
 * tagged identically as `cliArg` by the engine
 * (`src/utils/permissions/permissionSetup.ts:1015-1035`), so the two cannot be
 * told apart here. Splitting them needs that engine tag fixed first. A source
 * path with a line range, and a to-do addressed to a future engineer, are the
 * single most explicit thing CLAUDE.md §7 forbids rendering; they live in this
 * comment, beside the selector that decides the claim, so evidence and claim
 * still cannot drift apart.
 */
export const DIRECTORY_SOURCE_AMBIGUITY_NOTE =
  'Cat Code cannot tell which of these directories are just for this session.'
