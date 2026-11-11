export type EmailDiscoveryEntry = {
  provider: 'gmail' | 'outlook'
  label: string
}

const EMAIL_TOOLS: Readonly<Record<string, EmailDiscoveryEntry>> = {
  mcp__gmail__gmail_search: { provider: 'gmail', label: 'Search messages' },
  mcp__gmail__gmail_get_message: { provider: 'gmail', label: 'Read a message' },
  mcp__gmail__gmail_get_thread: { provider: 'gmail', label: 'Read a conversation' },
  mcp__gmail__gmail_list_labels: { provider: 'gmail', label: 'List labels' },
  mcp__gmail__gmail_send_message: { provider: 'gmail', label: 'Send messages' },
  'mcp__outlook__list-accounts': { provider: 'outlook', label: 'List accounts' },
  'mcp__outlook__list-mail-messages': { provider: 'outlook', label: 'List messages' },
}

/** Mixed searches keep their ordinary presentation so no discovered tool disappears. */
export function emailToolDiscovery(names: readonly string[] | undefined): EmailDiscoveryEntry[] | null {
  if (!names?.length || names.length > 100) return null
  const entries: EmailDiscoveryEntry[] = []
  for (const name of names) {
    const entry = Object.hasOwn(EMAIL_TOOLS, name) ? EMAIL_TOOLS[name] : undefined
    if (!entry) return null
    entries.push(entry)
  }
  return entries
}

export function requestedEmailToolDiscovery(query: unknown): EmailDiscoveryEntry[] | null {
  if (typeof query !== 'string' || query.length > 16_384) return null
  const selected = /^select:(.+)$/i.exec(query.trim())
  return selected ? emailToolDiscovery(selected[1]!.split(',').map(name => name.trim())) : null
}
