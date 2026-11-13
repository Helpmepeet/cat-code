import type { SlashCatalogEntry } from '../../shared/protocol.js'

export function parseSlashDraft(draft: string): string | null {
  const match = /^\/(\S*)$/.exec(draft)
  return match ? match[1] : null
}

export function filterSlashCommands(
  entries: readonly SlashCatalogEntry[],
  query: string,
): SlashCatalogEntry[] {
  const q = query.toLowerCase()
  if (q.length === 0) return [...entries]
  const prefix: SlashCatalogEntry[] = []
  const rest: SlashCatalogEntry[] = []
  for (const entry of entries) {
    const name = entry.name.toLowerCase()
    // A complete name leads its own prefix group, so `/mode` never resolves to `/model`.
    if (name === q) prefix.unshift(entry)
    else if (name.startsWith(q)) prefix.push(entry)
    else if (name.includes(q) || entry.description.toLowerCase().includes(q))
      rest.push(entry)
  }
  return [...prefix, ...rest]
}

export function nextSlashIndex(
  activeIndex: number,
  length: number,
  direction: 1 | -1,
): number {
  if (length <= 0) return 0
  return (activeIndex + direction + length) % length
}

export function completeSlashDraft(name: string): string {
  return `/${name} `
}

/** Characters a command name may contain, as the engine's mid-input matcher reads them. */
const COMMAND_NAME_CHAR = /[\w:-]/

/** A `/command` token the caret sits in, as offsets into the draft. */
export type InlineSlashToken = { start: number; end: number; query: string }

/**
 * The `/token` the caret is in or just after, when the slash starts the draft or
 * follows whitespace (engine `findMidInputSlashCommand`). The token runs past the
 * caret to the end of the name, so editing inside a name still filters on all of it.
 * Scans only the token itself, since this runs on every keystroke.
 */
export function findInlineSlashToken(
  draft: string,
  caret: number,
): InlineSlashToken | null {
  if (caret < 1 || caret > draft.length) return null
  let start = caret - 1
  while (start >= 0 && COMMAND_NAME_CHAR.test(draft[start]!)) start--
  if (start < 0 || draft[start] !== '/') return null
  if (start > 0 && !/\s/.test(draft[start - 1]!)) return null
  let end = caret
  while (end < draft.length && COMMAND_NAME_CHAR.test(draft[end]!)) end++
  return { start, end, query: draft.slice(start + 1, end) }
}

/**
 * Replace `token` with the picked command and one space after it, reusing a
 * space that is already there. `caret` lands after that space.
 */
export function applyInlineSlashCommand(
  draft: string,
  token: InlineSlashToken,
  name: string,
): { text: string; caret: number } {
  const after = draft.slice(token.end)
  const head = `${draft.slice(0, token.start)}/${name}`
  return {
    text: `${head}${after.startsWith(' ') ? '' : ' '}${after}`,
    caret: head.length + 1,
  }
}

/**
 * Where each known `/command` sits in the draft, for coloring. A slash counts
 * at the start of the draft or after whitespace, so paths like `a/b` never
 * match (engine `findSlashCommandPositions`). `isCommand` decides which names
 * are real and may treat the leading position differently.
 */
export function findSlashCommandRanges(
  text: string,
  isCommand: (name: string, start: number) => boolean,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  const pattern = /(^|\s)\/([a-zA-Z][\w:-]*)/g
  let match = pattern.exec(text)
  while (match) {
    const start = match.index + match[1]!.length
    const end = start + 1 + match[2]!.length
    if (isCommand(match[2]!, start)) ranges.push({ start, end })
    match = pattern.exec(text)
  }
  return ranges
}
