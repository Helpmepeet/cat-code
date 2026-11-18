const successors = new Map([
  ['gpt-6-astra', 'gpt-6.2-astra'],
  ['gpt-6.1-astra', 'gpt-6.2-astra'],
  ['gpt-6.1-sol', 'gpt-6.2-sol'],
  ['gpt-6-sol', 'gpt-6.2-sol'],
  ['gpt-5.6-sol', 'gpt-6.2-sol'],
  ['gpt-5.6-terra', 'gpt-6.1-terra'],
  ['gpt-5.6-luna', 'gpt-6-luna'],
  ['gpt-5.4', 'gpt-6-luna'],
  ['gpt-5.3-codex', 'gpt-6-luna'],
  ['gpt-5.4-mini', 'gpt-6-luna'],
  ['gpt-5.5', 'gpt-6.1-terra'],
])

/** Keep saved legacy selections runnable without carrying their [1m] suffix. */
export function remapRetiredGptModel(model: string): string {
  const base = model.trim().replace(/\[1m\]$/i, '').toLowerCase()
  return successors.get(base) ?? model
}
