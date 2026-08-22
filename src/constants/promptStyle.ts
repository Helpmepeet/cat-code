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
