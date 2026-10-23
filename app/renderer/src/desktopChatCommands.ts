import {
  PERMISSION_SET_MODE_MODES,
  type PermissionContextSnapshot,
  type PermissionSetModeMode,
  type RunControlsSnapshot,
  type SlashCatalogEntry,
} from '../../shared/protocol.js'

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

/**
 * Composer rail commands. The engine's `/model`, `/fast`, `/effort` and `/plan`
 * are terminal pickers the sidecar never advertises, so the desktop answers these
 * names itself by opening the same composer card a click on its face opens.
 */
export const DESKTOP_RAIL_COMMANDS = [
  'model',
  'effort',
  'fast',
  'mode',
  'plan',
  'account',
  'context',
] as const
export type DesktopRailCommand = (typeof DESKTOP_RAIL_COMMANDS)[number]

const DESKTOP_RAIL_DESCRIPTIONS: Record<DesktopRailCommand, string> = {
  model: 'Change the model.',
  effort: 'Change the reasoning effort.',
  fast: 'Turn fast mode on or off.',
  mode: 'Change the permission mode.',
  plan: 'Turn plan mode on or off.',
  account: 'Switch account.',
  context: 'Show context usage.',
}

/** Desktop-only commands are recognized only when the whole draft is a command. */
export function isDesktopNewChatCommand(draft: string): boolean {
  const command = draft.trim()
  return command === '/clear' || command === '/new'
}

export function parseDesktopRailCommand(draft: string): DesktopRailCommand | null {
  const command = draft.trim()
  return DESKTOP_RAIL_COMMANDS.find(name => command === `/${name}`) ?? null
}

/** `/plan` leaves Plan for the mode the engine recorded on entry, else Ask. */
export function nextPlanToggleMode(
  context: Pick<PermissionContextSnapshot, 'mode' | 'prePlanMode'>,
): PermissionSetModeMode {
  if (context.mode !== 'plan') return 'plan'
  const previous = PERMISSION_SET_MODE_MODES.find(
    mode => mode === context.prePlanMode && mode !== 'plan',
  )
  return previous ?? 'default'
}

/** The rail commands whose card or toggle can act right now, in menu order. */
export function selectDesktopRailCommands({
  runControls,
  canSetModel,
  canSetEffort,
  canSetFast,
  hasPermissionContext,
  canSwitchAccount,
  hasContextUsage,
}: {
  runControls: RunControlsSnapshot | null | undefined
  canSetModel: boolean
  canSetEffort: boolean
  canSetFast: boolean
  hasPermissionContext: boolean
  canSwitchAccount: boolean
  hasContextUsage: boolean
}): DesktopRailCommand[] {
  const available: Record<DesktopRailCommand, boolean> = {
    model: runControls != null && canSetModel &&
      runControls.model.options.some(option => option.value !== null),
    effort: runControls != null && canSetEffort &&
      runControls.effort.supported && runControls.effort.options.length > 0,
    fast: runControls != null && canSetFast && runControls.fast.supportedByModel &&
      (runControls.fast.active || runControls.fast.available),
    mode: runControls != null && hasPermissionContext,
    plan: hasPermissionContext,
    account: canSwitchAccount,
    context: hasContextUsage,
  }
  return DESKTOP_RAIL_COMMANDS.filter(name => available[name])
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
  railCommands: readonly DesktopRailCommand[] = [],
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
  // Set directly: the engine's `/context` stays hidden, but the desktop one is wanted.
  for (const name of railCommands) {
    entries.set(name, { name, description: DESKTOP_RAIL_DESCRIPTIONS[name] })
  }
  return [...entries.values()]
}
