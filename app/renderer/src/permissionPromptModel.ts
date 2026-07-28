import type { PermissionUpdate } from '@cat-code/engine/sdk'

export type PermissionKeyboardAction = 'allow' | 'deny' | 'dismiss'

type KeyLike = {
  key: string
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
}

export function permissionActionForKey(
  event: KeyLike,
): PermissionKeyboardAction | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null
  if (event.key === 'Enter') return 'allow'
  if (event.key.toLowerCase() === 'n' || event.key === 'Backspace') return 'deny'
  if (event.key === 'Escape') return 'dismiss'
  return null
}

/**
 * Where the rule would be kept, in the words the engine's own save-destination
 * picker shows a user (`src/components/permissions/rules/AddPermissionRules.tsx:20-37`).
 * `session` and `cliArg` are not settings files at all: they last for the run.
 */
const DESTINATION_LABEL: Record<PermissionUpdate['destination'], string> = {
  localSettings: 'Project settings (local)',
  projectSettings: 'Project settings',
  userSettings: 'User settings',
  session: 'This session',
  cliArg: 'This session',
}

function destinationLabel(destination: PermissionUpdate['destination']): string {
  return DESTINATION_LABEL[destination] ?? 'This session'
}

/**
 * Mode names as this app presents them (`MODE_META`, `PermissionModeChip.tsx`).
 * Duplicated rather than imported because a renderer `.tsx` may export React
 * components only (`lint:fast-refresh`). The total `Record` is the tripwire: a
 * new engine mode fails to compile until it gets a name here.
 */
type SuggestionMode = Extract<PermissionUpdate, { type: 'setMode' }>['mode']

const MODE_LABEL: Record<SuggestionMode, string> = {
  default: 'Ask permissions',
  acceptEdits: 'Accept edits',
  plan: 'Plan mode',
  dontAsk: 'Auto mode',
  bypassPermissions: 'Bypass permissions',
}

export function describeSuggestion(update: PermissionUpdate): string {
  switch (update.type) {
    case 'addRules':
    case 'replaceRules':
    case 'removeRules': {
      const rules = update.rules
        .map(rule =>
          rule.ruleContent
            ? `${rule.toolName}(${rule.ruleContent})`
            : rule.toolName,
        )
        .join(', ')
      return `${update.behavior} ${rules} · ${destinationLabel(update.destination)}`
    }
    case 'setMode':
      return `mode → ${MODE_LABEL[update.mode] ?? update.mode} · ${destinationLabel(update.destination)}`
    case 'addDirectories':
    case 'removeDirectories':
      return `${update.type === 'addDirectories' ? 'allow' : 'remove'} directory ${update.directories.join(', ')} · ${destinationLabel(update.destination)}`
    default: {
      const _exhaustive: never = update
      void _exhaustive
      return 'this permission change'
    }
  }
}
