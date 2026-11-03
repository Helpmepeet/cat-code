/** Host-owned routing identifiers only. Never credentials or account records. */
export type SessionAccountSelection = {
  anthropic?: string
  anthropicLoginGeneration?: number
  openai?: string
}

export function parseSessionAccountSelection(value: unknown): SessionAccountSelection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['anthropic', 'anthropicLoginGeneration', 'openai'].includes(key))) return undefined
  const result: SessionAccountSelection = {}
  for (const provider of ['anthropic', 'openai'] as const) {
    const id = input[provider]
    if (id === undefined) continue
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) return undefined
    result[provider] = id
  }
  if ('anthropicLoginGeneration' in input) {
    const generation = input.anthropicLoginGeneration
    if (!result.anthropic || typeof generation !== 'number' ||
      !Number.isSafeInteger(generation) || generation < 0) return undefined
    result.anthropicLoginGeneration = generation
  }
  return Object.keys(result).length ? result : undefined
}

/** A provider update cannot erase another provider's identity or generation. */
export function mergeSessionAccountSelection(
  current: SessionAccountSelection | undefined,
  update: SessionAccountSelection | undefined,
): SessionAccountSelection {
  const merged = { ...current, ...update }
  if (update?.anthropic && update.anthropic !== current?.anthropic &&
    update.anthropicLoginGeneration === undefined) delete merged.anthropicLoginGeneration
  return merged
}
