/**
 * The provider whose mark a model id earns, or null when the id names neither
 * family. Matches the engine's own `getProviderForModel`
 * (`src/utils/model/providerForModel.ts`) for `gpt-` and adds the `claude-`
 * family. Ids come from transcripts as the API echoed them, so they are full ids
 * and never aliases. A custom or unrecognised id yields null rather than a guess,
 * which keeps a surface's mark off rows it cannot name.
 */
export type ModelMarkProvider = 'anthropic' | 'openai'

export function modelMarkProvider(model: string | null | undefined): ModelMarkProvider | null {
  if (!model) return null
  if (model.startsWith('gpt-')) return 'openai'
  if (model.startsWith('claude-')) return 'anthropic'
  return null
}
