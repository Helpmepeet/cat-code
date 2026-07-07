/**
 * Settings domain capability — the sidecar-side read-seam over the engine's real
 * settings source/precedence model (P4-3; the W4 domain-recipe shape from
 * `permissionDomain.ts`, in its read-only form).
 *
 * Unlike the permission domain (which subscribes to the live app-state store),
 * settings resolve from disk relative to the process cwd via the engine's
 * `getSettingsWithSources()` (settings.ts:924). The sidecar process is spawned in
 * the session's cwd (P3-1), so the project/local layers are the SESSION's — the
 * same read the CLI makes and the same one `canUseTool` enforces. v1 is a
 * point-in-time read on attach (see `SettingsSnapshotFrame`); live re-emit is
 * deferred (general settings need a restart in the engine today).
 *
 * Secret posture: the snapshot carries the source/editable/managed MODEL only,
 * never setting VALUES, so no credential-bearing value (`env`, `apiKeyHelper`, …)
 * crosses IPC — the outbound `secretGuard` is satisfied by construction (proven
 * in `settingsDomain.test.ts`).
 *
 * This module has ZERO transport knowledge: frames, validation, and limits stay
 * in `sidecarServer.ts`.
 */

import { getSettingSourceDisplayNameLowercase } from '../../src/utils/settings/constants.js'
import type { SettingSource } from '../../src/utils/settings/constants.js'
import {
  getPolicySettingsOrigin,
  getSettingsFilePathForSource,
  getSettingsWithSources,
} from '../../src/utils/settings/settings.js'
import type { SettingSourceId, SettingsSnapshot } from '../shared/protocol.js'

export type SidecarSettingsDomain = {
  /** A point-in-time read of the engine's settings source/precedence model. */
  getSnapshot(): SettingsSnapshot
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
    }
  }
  resolved.sort((a, b) => a.key.localeCompare(b.key))

  return { layers: snapshotLayers, resolved, policyOrigin }
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
  return {
    getSnapshot() {
      // `sources` is ascending precedence, enabled + non-empty only
      // (settings.ts:924). Its `source` values are the engine's `SettingSource`,
      // structurally identical to the wire `SettingSourceId`.
      const { sources } = getSettingsWithSources()
      const layers: SettingsSourceLayer[] = sources.map(({ source, settings }) => ({
        source,
        origin: describeOrigin(source),
        settings: settings as Record<string, unknown>,
      }))
      return buildSettingsSnapshot(layers, getPolicySettingsOrigin())
    },
  }
}
