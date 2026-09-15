export type ModelImpliedProvider = 'openai'

/**
 * Derive the provider from a model name. Returns null when the model does not
 * imply a specific provider on its own, which keeps custom ids honest.
 */
export function getProviderForModel(model: string | null | undefined): ModelImpliedProvider | null {
  if (!model) return null
  if (model.startsWith('gpt-')) return 'openai'
  return null
}
