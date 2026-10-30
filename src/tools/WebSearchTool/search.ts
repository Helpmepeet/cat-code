import type { ToolUseContext } from '../../Tool.js'
import { AbortError, isAbortError } from '../../utils/errors.js'
import { resolveRequestProvider } from '../../utils/model/providers.js'
import { searchExa } from './exa.js'
import type { WebSearchInput, WebSearchOutput } from './types.js'

export async function searchWeb(
  input: WebSearchInput,
  context: ToolUseContext,
): Promise<WebSearchOutput> {
  const signal = context.abortController.signal
  if (signal.aborted) throw new AbortError()
  const startedAt = performance.now()

  const provider = context.options
    ? resolveRequestProvider(
        context.options.mainLoopModel,
        context.options.mainLoopProvider,
      )
    : undefined
  const needsExaContent =
    input.content === 'text' ||
    input.mode === 'extended' ||
    input.max_characters !== undefined
  const claudeNeedsExaFilters =
    (input.freshness !== undefined && input.freshness !== 'any') ||
    (Boolean(input.include_domains?.length) && Boolean(input.exclude_domains?.length))
  const nativeProvider = provider === 'openai'
    ? 'openai'
    : provider === 'firstParty' || provider === 'vertex' || provider === 'foundry'
      ? 'claude'
      : undefined
  const needsExaOptions = needsExaContent || (
    nativeProvider === 'openai'
      ? Boolean(input.exclude_domains?.length)
      : claudeNeedsExaFilters
  )

  let fallbackReason: string | undefined
  if (nativeProvider && !needsExaOptions) {
    try {
      const output = nativeProvider === 'openai'
        ? await (await import('./openai.js')).searchOpenAI(input, context)
        : await (await import('./claude.js')).searchClaude(input, context)
      if (signal.aborted) throw new AbortError()
      return { ...output, provider: nativeProvider, durationSeconds: (performance.now() - startedAt) / 1000 }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw new AbortError()
      fallbackReason = `${nativeProvider === 'openai' ? 'OpenAI' : 'Claude'} search was unavailable.`
    }
  } else if (needsExaOptions) {
    fallbackReason = 'The requested search options require Exa.'
  }

  if (signal.aborted) throw new AbortError()
  const output = await searchExa(input, signal)
  return {
    ...output,
    durationSeconds: (performance.now() - startedAt) / 1000,
    provider: 'exa',
    ...(fallbackReason ? { fallbackReason } : {}),
  }
}
