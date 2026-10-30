import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import type { WebSearchProgress } from '../../types/tools.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { getWebSearchPrompt, WEB_SEARCH_TOOL_NAME } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
} from './UI.js'
import { getSearchInputError, searchWeb } from './search.js'
import type { WebSearchOutput, WebSearchResult } from './types.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    query: z.string().trim().min(1).describe('The search query to use'),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        'Maximum returned links, from 1 to 100. Defaults to 10; native search may return fewer.',
      ),
    include_domains: z
      .array(z.string().trim().min(1))
      .max(20)
      .optional()
      .describe('Only include search results from these domains.'),
    exclude_domains: z
      .array(z.string().trim().min(1))
      .max(20)
      .optional()
      .describe('Claude search only: exclude these domains. Use either include_domains or exclude_domains, not both. Omit for OpenAI search.'),
    freshness: z
      .enum(['day', 'week', 'month', 'year', 'any'])
      .optional()
      .describe('OpenAI search only: recency filter. Omit for Claude search and put the desired time period in query instead. Defaults to any.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const searchResultSchema = lazySchema(() =>
  z.object({
    title: z.string().describe('The title of the search result'),
    url: z.string().describe('The URL of the search result'),
    publishedDate: z
      .string()
      .optional()
      .describe('Published date when the source provides it'),
    author: z.string().optional().describe('Author when the source provides it'),
    highlights: z.array(z.string()).optional().describe('Relevant highlights'),
    text: z.string().optional().describe('Source text when available'),
  }),
)

export type SearchResult = WebSearchResult

const outputSchema = lazySchema(() =>
  z.object({
    query: z.string().describe('The search query that was executed'),
    results: z.array(searchResultSchema()).describe('Web search results'),
    durationSeconds: z
      .number()
      .describe('Time taken to complete the search operation'),
    summary: z.string().optional().describe('Search summary returned by the provider'),
    provider: z.enum(['claude', 'openai', 'exa']).optional().describe('Search provider used'),
    fallbackReason: z.string().optional().describe('Fallback reason recorded in an older search result'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = WebSearchOutput

// Re-export WebSearchProgress from centralized types to break import cycles
export type { WebSearchProgress } from '../../types/tools.js'

export const WebSearchTool = buildTool({
  name: WEB_SEARCH_TOOL_NAME,
  searchHint: 'search the web for current information',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  async description(input) {
    return `Search the web for: ${input.query}`
  },
  userFacingName() {
    return 'Web Search'
  },
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Searching for ${summary}` : 'Searching the web'
  },
  isEnabled() {
    return !isEssentialTrafficOnly()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.query
  },
  async validateInput(input, context) {
    const message = getSearchInputError(input, context)
    return message ? { result: false, message, errorCode: 1 } : { result: true }
  },
  async checkPermissions(_input): Promise<PermissionResult> {
    return {
      behavior: 'passthrough',
      message: 'WebSearchTool requires permission.',
      suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: WEB_SEARCH_TOOL_NAME }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ],
    }
  },
  async prompt({ provider }) {
    return getWebSearchPrompt(provider)
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolResultMessage,
  extractSearchText() {
    return ''
  },
  async call(input, context, _canUseTool, _parentMessage, onProgress) {
    const toolUseID = context.toolUseId ?? `web-search-${Date.now()}`

    onProgress?.({
      toolUseID,
      data: {
        type: 'query_update',
        query: input.query,
      },
    })

    const output = await searchWeb(input, context)

    onProgress?.({
      toolUseID,
      data: {
        type: 'search_results_received',
        resultCount: output.results.length,
        query: input.query,
      },
    })

    return { data: output }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const { query, results } = output

    let formattedOutput = `Web search results for query: "${query}"\n\n`

    if (output.provider) {
      const name = output.provider === 'openai'
        ? 'OpenAI'
        : output.provider === 'claude' ? 'Claude' : 'Exa'
      formattedOutput += `Search provider: ${name}\n`
      if (output.fallbackReason) formattedOutput += `${output.fallbackReason}\n`
      formattedOutput += '\n'
    }

    if (results.length === 0) {
      formattedOutput += 'No results found.\n\n'
    } else {
      results.forEach((result, index) => {
        formattedOutput += `${index + 1}. ${result.title}\n`
        formattedOutput += `URL: ${result.url}\n`
        if (result.publishedDate) {
          formattedOutput += `Published: ${result.publishedDate}\n`
        }
        if (result.author) {
          formattedOutput += `Author: ${result.author}\n`
        }
        if (result.highlights?.length) {
          formattedOutput += 'Highlights:\n'
          result.highlights.forEach(highlight => {
            formattedOutput += `- ${highlight}\n`
          })
        }
        if (result.text) {
          formattedOutput += `Page text:\n${result.text}\n`
        }
        formattedOutput += '\n'
      })
    }

    if (output.summary) formattedOutput += `Search summary:\n${output.summary}\n\n`

    formattedOutput +=
      'REMINDER: Cite relevant source URLs from the WebSearch results using markdown hyperlinks.'

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: formattedOutput.trim(),
    }
  },
} satisfies ToolDef<InputSchema, Output, WebSearchProgress>)
