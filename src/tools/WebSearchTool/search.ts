import type { ToolUseContext } from '../../Tool.js'
import { AbortError, isAbortError } from '../../utils/errors.js'
import { resolveRequestProvider } from '../../utils/model/providers.js'
import type { WebSearchInput, WebSearchOutput } from './types.js'

export function getSearchInputError(input: WebSearchInput, context: ToolUseContext): string | undefined {
  if (!context.options?.mainLoopModel) return 'WebSearch requires the invoking model and provider context.'
  const provider = resolveRequestProvider(context.options.mainLoopModel, context.options.mainLoopProvider)
  if (provider === 'bedrock') return 'Native web search is unavailable on Bedrock. Use a Claude or OpenAI connection that supports web search.'
  if (provider === 'openai') {
    if (input.exclude_domains?.length) return 'OpenAI search does not support exclude_domains. Remove this option or use include_domains.'
  } else {
    if (input.freshness && input.freshness !== 'any') return 'Claude search does not support freshness. Remove this filter, express the desired time period in query, and verify source dates.'
    if (input.include_domains?.length && input.exclude_domains?.length) return 'Claude search supports include_domains or exclude_domains, not both. Retry with one domain filter.'
  }
  return undefined
}

export async function searchWeb(input: WebSearchInput, context: ToolUseContext): Promise<WebSearchOutput> {
  const signal = context.abortController.signal
  if (signal.aborted) throw new AbortError()
  const startedAt = performance.now()
  const inputError = getSearchInputError(input, context)
  if (inputError) throw new Error(inputError)
  const provider = resolveRequestProvider(context.options.mainLoopModel, context.options.mainLoopProvider)
  const nativeProvider = provider === 'openai' ? 'openai' : 'claude'
  try {
    const output = nativeProvider === 'openai'
      ? await (await import('./openai.js')).searchOpenAI(input, context)
      : await (await import('./claude.js')).searchClaude(input, context)
    if (signal.aborted) throw new AbortError()
    return { ...output, provider: nativeProvider, durationSeconds: (performance.now() - startedAt) / 1000 }
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw new AbortError()
    throw error
  }
}
