import type { SlashCatalogEntry } from '../../shared/protocol.js'

const DESKTOP_NEW_CHAT_COMMANDS = ['clear', 'new'] as const
const DESKTOP_NEW_CHAT_DESCRIPTION = 'Start a new chat.'
// Menu curation only: keep engine commands and model-invocable skills intact.
const HIDDEN_DESKTOP_SLASH_COMMANDS = new Set([
  'release-notes',
  'heapdump',
  'install-agents',
  'rename-account',
  'security-review',
  'context',
  'cost',
  'lorem-ipsum',
  'skillify',
  'remember',
  'update-config',
  'verify',
  'stuck',
  'review',
  'pr-comments',
  'cache-stats',
  'touch-all',
  'batch',
  'insights',
])

/** Desktop-only commands are recognized only when the whole draft is a command. */
export function isDesktopNewChatCommand(draft: string): boolean {
  const command = draft.trim()
  return command === '/clear' || command === '/new'
}

export function canExecuteDesktopNewChat({
  hasOrigin,
  hasQueuedPrompt,
  hasProjectRoute,
  workspaceBusy,
  preparingAttachment,
  managedFolderUnavailable,
  creationPending,
}: {
  hasOrigin: boolean
  hasQueuedPrompt: boolean
  hasProjectRoute: boolean
  workspaceBusy: boolean
  preparingAttachment: boolean
  managedFolderUnavailable: boolean
  creationPending: boolean
}): boolean {
  return (
    hasOrigin &&
    !hasQueuedPrompt &&
    !hasProjectRoute &&
    !workspaceBusy &&
    !preparingAttachment &&
    !managedFolderUnavailable &&
    !creationPending
  )
}

/** Merge desktop commands into either catalog while retaining unrelated metadata and order. */
export function mergeDesktopSlashCatalog(
  rich: readonly SlashCatalogEntry[],
  names: readonly string[],
): SlashCatalogEntry[] {
  const entries = new Map<string, SlashCatalogEntry>()
  const put = (entry: SlashCatalogEntry): void => {
    if (
      HIDDEN_DESKTOP_SLASH_COMMANDS.has(entry.name) ||
      entry.name.startsWith('understand-anything:')
    ) return
    const desktopCommand = DESKTOP_NEW_CHAT_COMMANDS.includes(
      entry.name as (typeof DESKTOP_NEW_CHAT_COMMANDS)[number],
    )
    const previous = entries.get(entry.name)
    entries.set(entry.name, desktopCommand
      ? { name: entry.name, description: DESKTOP_NEW_CHAT_DESCRIPTION }
      : previous ?? entry)
  }

  if (rich.length > 0) {
    for (const entry of rich) put(entry)
  } else {
    for (const name of names) put({ name, description: '' })
  }
  for (const name of DESKTOP_NEW_CHAT_COMMANDS) {
    put({ name, description: DESKTOP_NEW_CHAT_DESCRIPTION })
  }
  return [...entries.values()]
}
