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
import {
  hasExaApiKey,
  searchExa,
  type WebSearchOutput,
  type WebSearchResult,
} from './exa.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    query: z.string().trim().min(1).describe('The search query to use'),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe(
        'Maximum number of results. Defaults to 5. Must be between 1 and 10.',
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
      .describe('Exclude search results from these domains.'),
    freshness: z
      .enum(['day', 'week', 'month', 'year', 'any'])
      .optional()
      .describe('Published-date freshness filter. Defaults to any.'),
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
      .describe('Published date when Exa provides it'),
    author: z.string().optional().describe('Author when Exa provides it'),
    highlights: z.array(z.string()).optional().describe('Relevant highlights'),
  }),
)

export type SearchResult = WebSearchResult

const outputSchema = lazySchema(() =>
  z.object({
    query: z.string().describe('The search query that was executed'),
    results: z.array(searchResultSchema()).describe('Compact web search results'),
    durationSeconds: z
      .number()
      .describe('Time taken to complete the search operation'),
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
    return `Claude wants to search the web for: ${input.query}`
  },
  userFacingName() {
    return 'Web Search'
  },
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Searching for ${summary}` : 'Searching the web'
  },
  // The Exa key is the tool's only credential and it is read at call time
  // (`exa.ts` `getExaApiKey`), which threw. Advertising a tool that cannot run
  // spends a model turn to produce an error, so an absent key removes it from
  // the schema instead — the same shape as the privacy gate beside it.
  isEnabled() {
    return !isEssentialTrafficOnly() && hasExaApiKey()
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
  async prompt() {
    return getWebSearchPrompt()
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

    const output = await searchExa(input, context.abortController.signal)

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
        formattedOutput += '\n'
      })
    }

    formattedOutput +=
      'REMINDER: Cite relevant source URLs from the WebSearch results using markdown hyperlinks.'

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: formattedOutput.trim(),
    }
  },
} satisfies ToolDef<InputSchema, Output, WebSearchProgress>)
