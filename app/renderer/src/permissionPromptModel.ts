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
      return `${update.behavior} ${rules} · ${update.destination}`
    }
    case 'setMode':
      return `mode → ${update.mode} · ${update.destination}`
    case 'addDirectories':
    case 'removeDirectories':
      return `${update.type === 'addDirectories' ? 'allow' : 'remove'} directory ${update.directories.join(', ')} · ${update.destination}`
    default: {
      const _exhaustive: never = update
      return `unknown permission update · ${JSON.stringify(_exhaustive)}`
    }
  }
}
