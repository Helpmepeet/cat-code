/**
 * Settings extensions domain state (P4-12) — PROGRAM-PLAN §5 layer 3, the
 * renderer half of the `extensions.snapshot` read-seam. A reducer over the
 * read-only frame plus read-time selectors; it stays OUT of
 * `transcriptProjector.ts` (config state is not transcript state), exactly like
 * `settingsState.ts` / `agentConfigState.ts` (the recipe this copies).
 *
 * The snapshot is engine truth, faithful by construction; the four slices are
 * rendered by `SettingsExtensions.tsx`. Skills/hooks group by SOURCE and EVENT
 * respectively via the selectors here.
 */

import type {
  ExtensionsSnapshot,
  HookEntry,
  ServerFrame,
  SessionId,
  SkillConfigSource,
  SkillEntry,
} from '../../shared/protocol.js'

export type ExtensionsState = {
  sessions: Record<SessionId, ExtensionsSnapshot | null>
}

export type ExtensionsAction = { type: 'frame'; frame: ServerFrame }

export function createExtensionsState(): ExtensionsState {
  return { sessions: {} }
}

export function reduceExtensionsState(
  state: ExtensionsState,
  action: ExtensionsAction,
): ExtensionsState {
  const { frame } = action

  if (frame.kind === 'extensions.snapshot') {
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: frame.extensions },
    }
  }

  // A process/transport reset drops the stale snapshot; a fresh one arrives on
  // re-attach (mirrors settingsState's lifecycle handling). Untracked sessions
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

/** The latest extensions snapshot for a session (null before the first frame). */
export function selectExtensionsSnapshot(
  state: ExtensionsState,
  sessionId: SessionId | null,
): ExtensionsSnapshot | null {
  const snapshot = sessionId ? state.sessions[sessionId] : undefined
  return snapshot ?? null
}

/**
 * The skill source group order + labels, mirroring the prototype's `SKILL_GROUPS`
 * (`SkillsMenu.tsx:64-72`). `builtin`/`bundled` skills have no group in the menu
 * and are surfaced under a trailing "Other" group here rather than silently
 * dropped (the prototype's `if (source in groups)` drops them — a parity gain
 * flagged in the report).
 */
export const SKILL_SOURCE_GROUPS: ReadonlyArray<{
  source: SkillConfigSource
  label: string
}> = [
  { source: 'policySettings', label: 'Policy' },
  { source: 'userSettings', label: 'User' },
  { source: 'projectSettings', label: 'Project' },
  { source: 'localSettings', label: 'Local' },
  { source: 'flagSettings', label: 'Flag' },
  { source: 'plugin', label: 'Plugin' },
  { source: 'mcp', label: 'MCP' },
  { source: 'builtin', label: 'Built-in' },
  { source: 'bundled', label: 'Bundled' },
]

export type SkillSourceGroup = {
  source: SkillConfigSource
  label: string
  skills: SkillEntry[]
}

export function selectSkillGroups(
  snapshot: ExtensionsSnapshot | null,
): SkillSourceGroup[] {
  const skills = snapshot?.skills
  if (!skills) return []
  return SKILL_SOURCE_GROUPS.map(group => ({
    source: group.source,
    label: group.label,
    skills: skills.filter(skill => skill.source === group.source),
  })).filter(group => group.skills.length > 0)
}

export type HookEventGroup = {
  event: string
  hooks: HookEntry[]
}

/**
 * Hooks grouped by event, preserving the snapshot's canonical `HOOK_EVENTS`
 * order (the sidecar already sorted by that order, so first-seen wins here).
 */
export function selectHookGroups(
  snapshot: ExtensionsSnapshot | null,
): HookEventGroup[] {
  const hooks = snapshot?.hooks
  if (!hooks) return []
  const groups: HookEventGroup[] = []
  const byEvent = new Map<string, HookEntry[]>()
  for (const hook of hooks) {
    let bucket = byEvent.get(hook.event)
    if (!bucket) {
      bucket = []
      byEvent.set(hook.event, bucket)
      groups.push({ event: hook.event, hooks: bucket })
    }
    bucket.push(hook)
  }
  return groups
}
