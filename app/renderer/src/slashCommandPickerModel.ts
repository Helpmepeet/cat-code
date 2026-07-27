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
    if (name.startsWith(q)) prefix.push(entry)
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
