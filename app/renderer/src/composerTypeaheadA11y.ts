export type ComposerTypeaheadA11y = {
  listboxId: string
  activeOptionId: string
}

export const SLASH_COMMAND_LISTBOX_ID = 'composer-slash-command-matches'
export const MENTION_LISTBOX_ID = 'composer-mention-matches'

export function slashCommandOptionId(index: number): string {
  return `composer-slash-command-option-${index}`
}

export function mentionOptionId(index: number): string {
  return `composer-mention-option-${index}`
}
