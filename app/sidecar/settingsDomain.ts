/**
 * Settings domain capability — the sidecar-side read-seam over the engine's real
 * settings source/precedence model (P4-3; the W4 domain-recipe shape from
 * `permissionDomain.ts`, in its read-only form).
 *
 * Unlike the permission domain (which subscribes to the live app-state store),
 * settings resolve from disk relative to the process cwd. The read runs ONCE at
 * spawn via a NON-resetting path — `getSettingsForSource` per enabled source, in
 * the canonical `SETTING_SOURCES` precedence order — NOT `getSettingsWithSources()`,
 * whose first line is `resetSettingsCache()` (settings.ts:927) and would wipe the
 * engine's process-global settings cache against its "valid for the entire
 * session" invariant (:941). We only need the per-source layers (not the merged
 * `effective`), so the cached per-source reader suffices and mutates nothing.
 * The sidecar process is spawned in the session's cwd (P3-1), so the
 * project/local layers are the SESSION's — the same read `canUseTool` enforces.
 * v1 is thus a spawn-time snapshot; live re-emit is deferred (general settings
 * need a restart in the engine today; permission-rule changes flow via C3).
 *
 * Secret posture: the snapshot carries the source/editable/managed MODEL only,
 * never setting VALUES, so no credential-bearing value (`env`, `apiKeyHelper`, …)
 * crosses IPC — the outbound `secretGuard` is satisfied by construction (proven
 * in `settingsDomain.test.ts`).
 *
 * §0 reconciled (P4-5): the canonical domain read-seam recipe landed in
 * `accountsDomain.ts`. This seam CONFORMS to it — `createSidecar<X>Domain()`
 * returning a narrow interface, a throw-free `getSnapshot(): Snapshot | null`
 * that is secretGuard-clean by construction, emitted on attach after the C3
 * permission context. The one per-domain trait difference is deliberate, not a
 * divergence: settings freeze at spawn (the engine's session settings cache is
 * "valid for the entire session", settings.ts) so there is no `subscribe()`,
 * whereas accounts re-reads the live pool each `getSnapshot()` and re-broadcasts
 * after a mutating verb. Both are legitimate points on the recipe's lifecycle
 * axis (spawn-frozen ↔ attach + action-driven re-emit ↔ store-subscribed).
 *
 * This module has ZERO transport knowledge: frames, validation, and limits stay
 * in `sidecarServer.ts`.
 */

import {
  getSettingSourceDisplayNameLowercase,
  isSettingSourceEnabled,
  SETTING_SOURCES,
} from '../../src/utils/settings/constants.js'
import type { SettingSource } from '../../src/utils/settings/constants.js'
import {
  getPolicySettingsOrigin,
  getSettingsFilePathForSource,
  getSettingsForSource,
  updateSettingsForSource,
} from '../../src/utils/settings/settings.js'
import { getAllOutputStyles } from '../../src/constants/outputStyles.js'
import { getModelOptions } from '../../src/utils/model/modelOptions.js'
import type {
  EditableSettingSource,
  EditableSettingValue,
} from '../shared/settingsEditable.js'
import {
  EDITABLE_SETTING_KEYS,
  EDITABLE_SETTINGS_BY_KEY,
  isEditableSettingSource,
  SETTINGS_ENGINE_DEFAULT,
  validateEditableSettingValue,
  validateEditableSettingWrite,
} from '../shared/settingsEditable.js'
import type {
  SettingSourceId,
  SettingsSnapshot,
  SettingsVerbMessage,
} from '../shared/protocol.js'

/**
 * The live option sets for `dynamic-enum` editable keys — captured ONCE at spawn
 * (the option set is spawn-frozen like the settings layers) and carried on
 * `SettingsSnapshot.availableOptions`. Bounded + non-secret by construction.
 */
export type AvailableSettingOptions = NonNullable<
  SettingsSnapshot['availableOptions']
>

/** The outcome of one settings write verb. `changed` tells the server whether
 * to re-broadcast the (now-updated) snapshot. */
export type SettingsWriteResult = {
  ok: boolean
  message: string
  changed: boolean
}

export type SidecarSettingsDomain = {
  /**
   * The current settings source/precedence + editable-values model — a pure read
   * of the captured value (no disk I/O on the attach path). Initialized at spawn
   * and refreshed in place after a successful `runVerb` write. null if the
   * spawn-time read failed.
   */
  getSnapshot(): SettingsSnapshot | null
  /**
   * Apply one editable-setting write through the engine's
   * `SettingsUpdater`-under-lock form and refresh the cached snapshot. This is
   * the LAST line before disk — it re-validates the (already sidecar-validated)
   * verb against the same allowlist as defense-in-depth, and never touches a
   * non-editable source. The engine writer is the cross-process single writer
   * (lockfile + fresh under-lock read), so this cannot lose a concurrent update.
   */
  runVerb(verb: SettingsVerbMessage): SettingsWriteResult
}

/**
 * One raw settings layer as the pure builder consumes it. Kept structural
 * (`Record<string, unknown>`) so the builder never inspects VALUES — only the
 * top-level key names — and so tests can drive it with plain fixtures.
 */
export type SettingsSourceLayer = {
  source: SettingSourceId
  origin: string
  /** The raw per-source settings object. Only its top-level KEYS are read. */
  settings: Record<string, unknown>
}

/**
 * The two read-only layers: a value resolved from a CLI flag or organization
 * policy cannot be edited from the settings UI (mirrors the engine's
 * `EditableSettingSource = Exclude<SettingSource, 'policySettings' |
 * 'flagSettings'>`, constants.ts:182).
 */
const READ_ONLY_SOURCES: ReadonlySet<SettingSourceId> = new Set<SettingSourceId>(
  ['flagSettings', 'policySettings'],
)

/**
 * Pure — fold provenance-ordered layers into the redacted source/editable/
 * managed model. `layers` is ASCENDING precedence (index 0 lowest, matching
 * `getSettingsWithSources().sources`). The winner of each key is the
 * HIGHEST-precedence layer that carries it, so the walk runs high → low and
 * keeps the first hit. VALUES are never touched — only `Object.keys`.
 */
export function buildSettingsSnapshot(
  layers: readonly SettingsSourceLayer[],
  policyOrigin: SettingsSnapshot['policyOrigin'],
  availableOptions: AvailableSettingOptions = [],
): SettingsSnapshot {
  const snapshotLayers = layers.map(layer => ({
    source: layer.source,
    origin: layer.origin,
    keys: Object.keys(layer.settings),
  }))

  const resolved: SettingsSnapshot['resolved'] = []
  // editableValues carries VALUES — but ONLY for the closed non-secret allowlist
  // (EDITABLE_SETTING_KEYS); every other key stays values-free.
  //
  // Deliberately NOT gated on the shared `seen` set, for the same reason as
  // `permissionDefaultMode` below: `seen` answers "which layer WINS this key",
  // which is the right question for `resolved` and the wrong one here. The
  // settings UI is scope-relative — the operator picks a layer and edits that
  // layer's own value — so a key set at two layers needs an entry for EACH,
  // not just the winner's. Gating it meant an overridden row could show no
  // value at its own scope and lose its editor.
  //
  // The walk runs high→low precedence and `sort` is stable, so among entries
  // for one key the WINNER stays first. `selectEditableValue` (the renderer's
  // key-only lookup) therefore keeps resolving to the winning value unchanged;
  // a scope-aware reader matches on `{key, source}`.
  const editableValues: SettingsSnapshot['editableValues'] = []
  // CC-13 — `permissions.defaultMode` is resolved on its OWN axis, deliberately
  // NOT gated on the `seen` top-level set: the engine deep-merges settings
  // (`mergeWith(..., settingsMergeCustomizer)`, settings.ts:848) so a nested
  // scalar is overridden per-key, not per top-level object. A higher layer that
  // sets only `permissions.allow` must therefore NOT hide a `defaultMode` set at
  // a lower layer — which is exactly what folding it into `seen` would do.
  let permissionDefaultMode: SettingsSnapshot['permissionDefaultMode']
  const seen = new Set<string>()
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]!
    if (!permissionDefaultMode) {
      const mode = readPermissionDefaultMode(layer.settings)
      if (mode !== null) {
        permissionDefaultMode = { value: mode, source: layer.source }
      }
    }
    for (const key of Object.keys(layer.settings)) {
      if (EDITABLE_SETTING_KEYS.has(key)) {
        // Only emit a value that matches the key's declared scalar control —
        // never an unexpected shape (belt-and-suspenders against a hand-edited
        // file; the read already schema-validated it, and this keeps the frame
        // JSON-safe + secretGuard-clean by construction).
        const validation = validateEditableSettingValue(key, layer.settings[key])
        if (validation.ok) {
          editableValues.push({ key, value: validation.value, source: layer.source })
        }
      }
      if (seen.has(key)) continue
      seen.add(key)
      resolved.push({
        key,
        source: layer.source,
        managed: layer.source === 'policySettings',
        editable: !READ_ONLY_SOURCES.has(layer.source),
      })
    }
  }
  resolved.sort((a, b) => a.key.localeCompare(b.key))
  editableValues.sort((a, b) => a.key.localeCompare(b.key))

  return {
    layers: snapshotLayers,
    resolved,
    policyOrigin,
    editableValues,
    availableOptions,
    ...(permissionDefaultMode ? { permissionDefaultMode } : {}),
  }
}

/**
 * The raw `permissions.defaultMode` of ONE layer, or null when that layer does
 * not set it. A shape guard only — the per-source read already schema-validated
 * the file against `SettingsSchema` (types.ts:59, an optional enum), and the
 * mode vocabulary is feature-gated engine-side (`PERMISSION_MODES` vs
 * `EXTERNAL_PERMISSION_MODES`), so re-deriving that enum here would fork it.
 * Keeping this a pure structural read is also what lets `buildSettingsSnapshot`
 * stay pure and fixture-drivable.
 */
function readPermissionDefaultMode(
  settings: Record<string, unknown>,
): string | null {
  const permissions = settings['permissions']
  if (typeof permissions !== 'object' || permissions === null) return null
  const mode = (permissions as Record<string, unknown>)['defaultMode']
  return typeof mode === 'string' && mode.length > 0 ? mode : null
}

/**
 * Human-readable origin for a layer's source badge tooltip. Prefers the real
 * settings-file path; falls back to the source's display name when there is no
 * single file (e.g. inline SDK flag settings). The policy layer uses the file
 * path even when the ACTIVE policy is remote/MDM — `policyOrigin` on the
 * snapshot carries the precise managed source separately.
 */
function describeOrigin(source: SettingSource): string {
  return (
    getSettingsFilePathForSource(source) ??
    getSettingSourceDisplayNameLowercase(source)
  )
}

export function createSidecarSettingsDomain(
  availableOptions: AvailableSettingOptions = [],
): SidecarSettingsDomain {
  // Read ONCE at spawn (see the module header for why: the attach path must do no
  // disk I/O and must not reset the engine's global settings cache). getSnapshot()
  // then just returns the captured value — a pure read that cannot throw or
  // strand an attaching connection (review MED#1 + MED#2). A successful runVerb()
  // write refreshes this in place (the engine writer already reset the cache, so
  // the re-read reflects the just-written file). `availableOptions` is spawn-frozen
  // like the layers (the option registries do not change on a settings write), so
  // the SAME captured list is reused on every refresh + membership check.
  let snapshot = readSettingsSnapshotOnce(availableOptions)
  return {
    getSnapshot() {
      return snapshot
    },
    runVerb(verb: SettingsVerbMessage): SettingsWriteResult {
      const result = applySettingsVerb(verb, availableOptions)
      if (result.changed) {
        snapshot = readSettingsSnapshotOnce(availableOptions)
      }
      return result
    },
  }
}

/**
 * Defense-in-depth re-validation + the engine write. The sidecar SERVER is the
 * primary trust boundary (schema + strict-key allowlist + per-key validator);
 * this repeats the source/key/value checks as the last gate before disk, so the
 * engine-touching path can never write a non-editable source, an unknown key, or
 * a mistyped value even if the boundary were bypassed.
 */
function applySettingsVerb(
  verb: SettingsVerbMessage,
  availableOptions: AvailableSettingOptions,
): SettingsWriteResult {
  if (!isEditableSettingSource(verb.source)) {
    return { ok: false, message: `not an editable settings source`, changed: false }
  }
  if (!EDITABLE_SETTING_KEYS.has(verb.key)) {
    return { ok: false, message: `not an editable setting: ${verb.key}`, changed: false }
  }
  const validation = validateEditableSettingWrite(verb.key, verb.value)
  if (!validation.ok) {
    return { ok: false, message: validation.error, changed: false }
  }
  // The closed membership gate for a `dynamic-enum` key (the static validator
  // above only bounds the string): the value must be one of the options the
  // sidecar captured at spawn. Fail closed — no captured options ⇒ no write.
  // A CLEAR (P4-41) names no option, so this gate does not apply to it; the
  // key/source allowlists above have already run, so a clear is exactly as
  // constrained as a write about WHERE it may land.
  if (
    !validation.clear &&
    EDITABLE_SETTINGS_BY_KEY.get(verb.key)?.control.kind === 'dynamic-enum'
  ) {
    const options = availableOptions.find(entry => entry.key === verb.key)?.options
    if (!options?.some(option => option.value === validation.value)) {
      // The rejected value is NOT echoed. This message reaches a toast, and the
      // one value that can plausibly be rejected here is the reserved
      // `SETTINGS_ENGINE_DEFAULT` token, which is internal vocabulary no user
      // should ever read (CLAUDE.md §7). The renderer offered the option, so
      // repeating it back adds nothing anyway.
      return {
        ok: false,
        message: `not an available option for ${verb.key}`,
        changed: false,
      }
    }
  }
  const source: EditableSettingSource = verb.source
  // Two ways to reach the same removal, and they are NOT the same mechanism:
  //  - `value === null` (P4-41) is the general clear channel — every control kind,
  //    outside the value domain by type, so it can never be a user's value;
  //  - `SETTINGS_ENGINE_DEFAULT` is the `model` select's "no override" OPTION.
  //    It reaches here only because it is one of the captured options above, and
  //    it can never reach a settings file — a settings file holding the token
  //    would be a model name no engine knows.
  // Both routes collapse into ONE decision the writer below can prove: null =
  // remove the key, anything else = write that value.
  const nextValue: EditableSettingValue | null =
    validation.clear || validation.value === SETTINGS_ENGINE_DEFAULT
      ? null
      : validation.value
  const clearsKey = nextValue === null
  // The SettingsUpdater FUNCTION form (settings.ts:461/480): the engine invokes
  // this under the cross-process lock with the FRESH on-disk settings, and writes
  // the return VERBATIM (no merge). Computing the next object from that
  // under-lock `current` is the exact P3-5a/DR-2 no-lost-update fix — a value
  // computed from a pre-lock read would clobber a concurrent write.
  const { error } = updateSettingsForSource(source, current => {
    const next = { ...(current ?? {}) } as Record<string, unknown>
    if (nextValue === null) delete next[verb.key]
    else next[verb.key] = nextValue
    return next
  })
  if (error) {
    return { ok: false, message: error.message, changed: false }
  }
  return {
    ok: true,
    message: clearsKey ? `Cleared ${verb.key}.` : `Updated ${verb.key}.`,
    changed: true,
  }
}

/**
 * Build the snapshot once from the cached per-source settings, ordered by the
 * canonical `SETTING_SOURCES` precedence (ascending; policy last, so it wins) —
 * never `getEnabledSettingSources()` insertion order, which appends policy before
 * flag. Returns null (and logs) on any read failure so the caller degrades
 * gracefully instead of crashing a session.
 */
function readSettingsSnapshotOnce(
  availableOptions: AvailableSettingOptions,
): SettingsSnapshot | null {
  try {
    const layers: SettingsSourceLayer[] = []
    for (const source of SETTING_SOURCES) {
      if (!isSettingSourceEnabled(source)) continue
      const settings = getSettingsForSource(source)
      if (settings && Object.keys(settings).length > 0) {
        layers.push({
          source,
          origin: describeOrigin(source),
          settings: settings as Record<string, unknown>,
        })
      }
    }
    return buildSettingsSnapshot(layers, getPolicySettingsOrigin(), availableOptions)
  } catch (error) {
    process.stderr.write(
      `[sidecar] settings snapshot read failed (session runs without a settings snapshot): ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    return null
  }
}

/**
 * Load the live option sets for `dynamic-enum` editable keys ONCE at spawn, from
 * the engine's own registries — the SAME source the running engine resolves the
 * value from (no fixture, no renderer-side list). Today: `outputStyle` from
 * `getAllOutputStyles(cwd)` (built-in default/Explanatory/Learning + any custom
 * dir + plugin styles), rooted at the session cwd so project/plugin styles are
 * the SESSION's. The option `value` is the style NAME, which is exactly what
 * `settings.outputStyle` stores (outputStyles.ts:209).
 *
 * `model` comes from `getModelOptions()` (`src/utils/model/modelOptions.ts:651`),
 * the same list the engine's own model picker is built from, so the roster
 * reflects this machine's real credentials rather than a hard-coded table. It is
 * taken UNFILTERED: the composer's run-control picker narrows to the session's
 * live provider, but this key is the persisted default for sessions that do not
 * exist yet.
 *
 * Fails soft per registry: a failed slice simply carries no options, and its
 * select renders disabled.
 */
export async function loadAvailableSettingOptions(
  cwd: string,
): Promise<AvailableSettingOptions> {
  const available: AvailableSettingOptions = []
  try {
    // `getModelOptions` returns `value: ModelSetting` (`string | null`), and the
    // null row is the engine's own "Default (recommended)" — the state of having
    // no override. It maps onto the reserved token so the select can offer it
    // and the write path can clear the key; every other row is a real model id.
    const options = getModelOptions().map(option => ({
      value: option.value ?? SETTINGS_ENGINE_DEFAULT,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
    }))
    if (options.length > 0) available.push({ key: 'model', options })
  } catch (error) {
    process.stderr.write(
      `[sidecar] model options read failed (the default-model select renders disabled): ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
  }
  try {
    const styles = await getAllOutputStyles(cwd)
    const options = Object.entries(styles)
      // The reserved token is a chooser, never a style NAME (settingsEditable.ts).
      // A user-authored style called after it would otherwise arrive as a
      // selectable option whose write CLEARS the key instead of setting it —
      // the one way an in-band string sentinel can collide with a real value.
      .filter(([name]) => name !== SETTINGS_ENGINE_DEFAULT)
      .map(([name, config]) => ({
        value: name,
        // The built-in 'default' style has a null config; the prototype labels it
        // "Default" (Settings.jsx:364). Every other style uses its real name.
        label: name === 'default' ? 'Default' : (config?.name ?? name),
        ...(config?.description ? { description: config.description } : {}),
      }))
    if (options.length > 0) {
      available.push({ key: 'outputStyle', options })
    }
  } catch (error) {
    process.stderr.write(
      `[sidecar] output-style options read failed (the output-style select renders disabled): ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
  }
  return available
}
