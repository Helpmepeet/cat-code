import type { PermissionSetModeMode } from '../../shared/protocol.js'

/**
 * User-facing vocabulary for the permission context. The sidecar intentionally
 * carries source and mode values as strings so an older renderer can display a
 * newer engine without crashing; unrecognised values therefore need a neutral
 * label rather than being rendered verbatim.
 */
export type PermissionModeMeta = {
  short: string
  title: string
  desc: string
  toneText: string
  toneDot: string
}

/**
 * The one mode vocabulary used by the composer chip, read-only rules panel,
 * and permission-suggestion cards. The total record is the tripwire: adding a
 * selectable wire mode requires its user-facing name and presentation here.
 */
export const PERMISSION_MODE_META = {
  default: {
    short: 'Ask',
    title: 'Ask permissions',
    desc: 'Confirm before each tool use',
    toneText: 'text-text-muted',
    toneDot: 'bg-text-subtle',
  },
  acceptEdits: {
    short: 'Accept edits',
    title: 'Accept edits',
    desc: 'Auto-accept edits, ask for commands',
    toneText: 'text-emerald-400',
    toneDot: 'bg-emerald-400',
  },
  plan: {
    short: 'Plan',
    title: 'Plan mode',
    desc: 'Research & plan only, no changes',
    toneText: 'text-sky-400',
    toneDot: 'bg-sky-400',
  },
  auto: {
    short: 'Auto',
    title: 'Auto mode',
    desc: 'Use the safety classifier for unapproved actions',
    toneText: 'text-accent',
    toneDot: 'bg-accent',
  },
  dontAsk: {
    short: "Don't ask",
    title: "Don't ask",
    desc: 'Deny anything that needs approval',
    toneText: 'text-red-400',
    toneDot: 'bg-red-400',
  },
  bypassPermissions: {
    short: 'Bypass',
    title: 'Bypass permissions',
    desc: 'Run everything without asking',
    toneText: 'text-amber-400',
    toneDot: 'bg-amber-400',
  },
} satisfies Record<PermissionSetModeMode, PermissionModeMeta>

export function isPermissionSetMode(
  mode: string,
): mode is PermissionSetModeMode {
  return Object.hasOwn(PERMISSION_MODE_META, mode)
}

export function permissionModeMeta(mode: string): PermissionModeMeta | null {
  return isPermissionSetMode(mode) ? PERMISSION_MODE_META[mode] : null
}

export function permissionModeShortLabel(mode: string): string {
  return permissionModeMeta(mode)?.short ?? 'Unknown mode'
}

export function permissionModeTitle(mode: string): string {
  return permissionModeMeta(mode)?.title ?? 'Unknown permission mode'
}

/**
 * The engine's closed PermissionRuleSource union at
 * `src/types/permissions.ts:54-62`. The outbound protocol deliberately keeps
 * the field open as `string` for forwards compatibility, so this table records
 * all current values while the formatter below safely handles future ones.
 */
type CurrentPermissionRuleSource =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'flagSettings'
  | 'policySettings'
  | 'cliArg'
  | 'command'
  | 'session'

const PERMISSION_RULE_SOURCE_LABEL = {
  userSettings: 'your defaults',
  projectSettings: "this project's settings",
  localSettings: 'your private settings',
  flagSettings: 'a launch flag',
  policySettings: 'organization policy',
  cliArg: 'a launch flag',
  command: 'a command',
  session: 'this session',
} satisfies Record<CurrentPermissionRuleSource, string>

export function permissionRuleSourceLabel(source: string): string {
  return Object.hasOwn(PERMISSION_RULE_SOURCE_LABEL, source)
    ? PERMISSION_RULE_SOURCE_LABEL[source as CurrentPermissionRuleSource]
    : 'another source'
}
