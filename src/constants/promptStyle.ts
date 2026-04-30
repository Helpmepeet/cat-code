import {
  getAPIProvider,
  resolveRequestProvider,
  type APIProvider,
} from '../utils/model/providers.js'

/**
 * Returns true when the effective provider is OpenAI, indicating that
 * GPT-optimized prompt style should be used instead of Claude-style.
 *
 * Call this with the effective request provider whenever one is available.
 * If no provider is supplied, it falls back to the current session provider.
 */
export function isGPTPromptStyle(provider: APIProvider = getAPIProvider()): boolean {
  return provider === 'openai'
}

/**
 * Convenience helper for request-aware call sites that only have the model.
 * GPT-family models always map to OpenAI; ambiguous model IDs inherit the
 * supplied base provider (or the current session provider if omitted).
 */
export function isGPTPromptStyleForModel(
  model: string | null | undefined,
  baseProvider?: APIProvider,
): boolean {
  return resolveRequestProvider(model, baseProvider) === 'openai'
}
