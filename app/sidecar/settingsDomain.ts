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
import type { EditableSettingSource } from '../shared/settingsEditable.js'
import {
  EDITABLE_SETTING_KEYS,
  isEditableSettingSource,
  validateEditableSettingValue,
} from '../shared/settingsEditable.js'
import type {
  SettingSourceId,
  SettingsSnapshot,
  SettingsVerbMessage,
} from '../shared/protocol.js'

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
): SettingsSnapshot {
  const snapshotLayers = layers.map(layer => ({
    source: layer.source,
    origin: layer.origin,
    keys: Object.keys(layer.settings),
  }))

  const resolved: SettingsSnapshot['resolved'] = []
  // editableValues carries VALUES — but ONLY for the closed non-secret allowlist
  // (EDITABLE_SETTING_KEYS); every other key stays values-free. The winning
  // (highest-precedence) layer's value is captured in the same high→low walk.
  const editableValues: SettingsSnapshot['editableValues'] = []
  const seen = new Set<string>()
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]!
    for (const key of Object.keys(layer.settings)) {
      if (seen.has(key)) continue
      seen.add(key)
      resolved.push({
        key,
        source: layer.source,
        managed: layer.source === 'policySettings',
        editable: !READ_ONLY_SOURCES.has(layer.source),
      })
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
    }
  }
  resolved.sort((a, b) => a.key.localeCompare(b.key))
  editableValues.sort((a, b) => a.key.localeCompare(b.key))

  return { layers: snapshotLayers, resolved, policyOrigin, editableValues }
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

export function createSidecarSettingsDomain(): SidecarSettingsDomain {
  // Read ONCE at spawn (see the module header for why: the attach path must do no
  // disk I/O and must not reset the engine's global settings cache). getSnapshot()
  // then just returns the captured value — a pure read that cannot throw or
  // strand an attaching connection (review MED#1 + MED#2). A successful runVerb()
  // write refreshes this in place (the engine writer already reset the cache, so
  // the re-read reflects the just-written file).
  let snapshot = readSettingsSnapshotOnce()
  return {
    getSnapshot() {
      return snapshot
    },
    runVerb(verb: SettingsVerbMessage): SettingsWriteResult {
      const result = applySettingsVerb(verb)
      if (result.changed) {
        snapshot = readSettingsSnapshotOnce()
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
function applySettingsVerb(verb: SettingsVerbMessage): SettingsWriteResult {
  if (!isEditableSettingSource(verb.source)) {
    return { ok: false, message: `not an editable settings source`, changed: false }
  }
  if (!EDITABLE_SETTING_KEYS.has(verb.key)) {
    return { ok: false, message: `not an editable setting: ${verb.key}`, changed: false }
  }
  const validation = validateEditableSettingValue(verb.key, verb.value)
  if (!validation.ok) {
    return { ok: false, message: validation.error, changed: false }
  }
  const value = validation.value
  const source: EditableSettingSource = verb.source
  // The SettingsUpdater FUNCTION form (settings.ts:461/480): the engine invokes
  // this under the cross-process lock with the FRESH on-disk settings, and writes
  // the return VERBATIM (no merge). Computing `{ ...current, [key]: value }` from
  // that under-lock `current` is the exact P3-5a/DR-2 no-lost-update fix — a value
  // computed from a pre-lock read would clobber a concurrent write.
  const { error } = updateSettingsForSource(source, current => ({
    ...(current ?? {}),
    [verb.key]: value,
  }))
  if (error) {
    return { ok: false, message: error.message, changed: false }
  }
  return { ok: true, message: `Updated ${verb.key}.`, changed: true }
}

/**
 * Build the snapshot once from the cached per-source settings, ordered by the
 * canonical `SETTING_SOURCES` precedence (ascending; policy last, so it wins) —
 * never `getEnabledSettingSources()` insertion order, which appends policy before
 * flag. Returns null (and logs) on any read failure so the caller degrades
 * gracefully instead of crashing a session.
 */
function readSettingsSnapshotOnce(): SettingsSnapshot | null {
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
    return buildSettingsSnapshot(layers, getPolicySettingsOrigin())
  } catch (error) {
    process.stderr.write(
      `[sidecar] settings snapshot read failed (session runs without a settings snapshot): ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    return null
  }
}
