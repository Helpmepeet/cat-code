/** Host-owned routing identifiers only. Never credentials or account records. */
export type SessionAccountSelection = {
  anthropic?: string
  openai?: string
}

export function parseSessionAccountSelection(value: unknown): SessionAccountSelection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const result: SessionAccountSelection = {}
  for (const provider of ['anthropic', 'openai'] as const) {
    const id = input[provider]
    if (typeof id === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(id)) result[provider] = id
  }
  return Object.keys(result).length ? result : undefined
}
