import type {
  ExtensionsSnapshot,
  HookEntry,
  SkillConfigSource,
  SkillEntry,
} from '../../shared/protocol.js'

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
