import {
  getAPIProvider,
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

export type GPTPromptFamily = 'gpt-5.6' | 'gpt-6-astra'

// The shipped Sol/Terra/Luna templates are identical. Astra differs by
// generation, not capability tier. Unknown IDs retain the shared baseline;
// adopting another family requires evidence rather than a numeric >= test.
// Match the transport's exact IDs: differently cased/suffixed names fall back
// to 5.6 there too, so display-name normalization must not select Astra here.
export function getGPTPromptFamily(model: string): GPTPromptFamily {
  return model === 'gpt-6-astra'
    ? 'gpt-6-astra'
    : 'gpt-5.6'
}
