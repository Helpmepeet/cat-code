/**
 * Settings domain state — PROGRAM-PLAN §5 layer 3 (per-domain selector), the
 * renderer half of the P4-3 read-seam. A reducer over the read-only
 * `settings.snapshot` frame plus read-time selectors; it stays OUT of
 * `transcriptProjector.ts` (settings state is not transcript state), exactly like
 * `permissionState.ts` (P2-4, the recipe this copies).
 *
 * The snapshot is engine truth, faithful by construction — the source/precedence
 * model is never reconstructed renderer-side. Panels (P4-12) consume the
 * selectors here to source-badge every field; this session ships the seam + the
 * `Field`/`SourceBadge`/`ManagedBadge` primitives, not the value editors.
 */

import type {
  ServerFrame,
  SettingSourceId,
  SettingsSnapshot,
  SessionId,
} from '../../shared/protocol.js'

export type SettingsState = {
  /** Latest snapshot per session; null once seen-then-reset (lifecycle). */
  sessions: Record<SessionId, SettingsSnapshot | null>
}

export type SettingsAction = { type: 'frame'; frame: ServerFrame }

export function createSettingsState(): SettingsState {
  return { sessions: {} }
}

export function reduceSettingsState(
  state: SettingsState,
  action: SettingsAction,
): SettingsState {
  const { frame } = action

  if (frame.kind === 'settings.snapshot') {
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: frame.settings },
    }
  }

  // A process/transport reset drops the stale snapshot; a fresh one arrives on
  // re-attach (mirrors permissionState's lifecycle handling). Untracked sessions
  // are left alone so we don't materialize an empty slot for every lifecycle.
  if (frame.kind === 'lifecycle') {
    if (!(frame.sessionId in state.sessions)) return state
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: null },
    }
  }

  return state
}

export type SettingResolution = SettingsSnapshot['resolved'][number]

/** The latest engine settings snapshot for a session (null before the first frame). */
export function selectSettingsSnapshot(
  state: SettingsState,
  sessionId: SessionId | null,
): SettingsSnapshot | null {
  const snapshot = sessionId ? state.sessions[sessionId] : undefined
  return snapshot ?? null
}

/**
 * The winning source + editable/managed status for one setting key — the
 * lookup every `Field` in a panel makes. null when the key is unset at every
 * enabled layer (i.e. the value is at its built-in default).
 */
export function selectSettingField(
  snapshot: SettingsSnapshot | null,
  key: string,
): SettingResolution | null {
  if (!snapshot) return null
  return snapshot.resolved.find(resolution => resolution.key === key) ?? null
}

/**
 * Precedence order for DISPLAY, high → low (policy wins) — the reverse of the
 * ascending `SETTING_SOURCES` layering, matching the prototype's "Resolution
 * order" legend (Settings.jsx: policy ▸ flag ▸ local ▸ project ▸ user).
 */
export const SETTING_SOURCE_PRECEDENCE: readonly SettingSourceId[] = [
  'policySettings',
  'flagSettings',
  'localSettings',
  'projectSettings',
  'userSettings',
]

/** The managed (policy-locked) resolved fields — drives the Managed panel. */
export function selectManagedFields(
  snapshot: SettingsSnapshot | null,
): SettingResolution[] {
  if (!snapshot) return []
  return snapshot.resolved.filter(resolution => resolution.managed)
}

/**
 * The origin string (settings-file path / policy descriptor) for a source
 * layer, for a badge tooltip. null when that layer is absent from the snapshot.
 */
export function selectLayerOrigin(
  snapshot: SettingsSnapshot | null,
  source: SettingSourceId,
): string | null {
  if (!snapshot) return null
  return snapshot.layers.find(layer => layer.source === source)?.origin ?? null
}
