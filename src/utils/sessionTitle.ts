/**
 * Session title generation via Haiku.
 *
 * Standalone module with minimal dependencies so it can be imported from
 * print.ts (SDK control request handler) without pulling in the React/chalk/
 * git dependency chain that teleport.tsx carries.
 *
 * This is the single source of truth for AI-generated session titles across
 * all surfaces. Previously there were separate Haiku title generators:
 * - teleport.tsx generateTitleAndBranch (6-word title + branch for CCR)
 * - rename/generateSessionName.ts (kebab-case name for /rename)
 * Each remains for backwards compat; new callers should use this module.
 */

import { randomUUID } from 'crypto'
import { z } from 'zod/v4'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { logEvent } from '../services/analytics/index.js'
import { queryModelWithoutStreaming } from '../services/api/claude.js'
import { clearWebSocketSession } from '../services/api/codex-websocket-transport.js'
import { buildProviderInstructionAssembly } from '../services/api/instructionAssembly.js'
import { getEmptyToolPermissionContext } from '../Tool.js'
import {
  SYNTHETIC_OUTPUT_TOOL_NAME,
  createSyntheticOutputTool,
} from '../tools/SyntheticOutputTool/SyntheticOutputTool.js'
import type { Message } from '../types/message.js'
import { logForDebugging } from './debug.js'
import { lazySchema } from './lazySchema.js'
import {
  createUserMessage,
  normalizeMessagesForAPI,
} from './messages.js'
import { getSmallFastModelForProvider } from './model/model.js'
import { resolveRequestProvider } from './model/providers.js'
import { asSystemPrompt } from './systemPromptType.js'

const MAX_CONVERSATION_TEXT = 1000

/**
 * Flatten a message array into a single text string for Haiku title input.
 * Skips meta/non-human messages. Tail-slices to the last 1000 chars so
 * recent context wins when the conversation is long.
 */
export function extractConversationText(messages: Message[]): string {
  const parts: string[] = []
  for (const msg of messages) {
    if (msg.type !== 'user' && msg.type !== 'assistant') continue
    if ('isMeta' in msg && msg.isMeta) continue
    if ('origin' in msg && msg.origin && msg.origin.kind !== 'human') continue
    const content = msg.message.content
    if (typeof content === 'string') {
      parts.push(content)
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if ('type' in block && block.type === 'text' && 'text' in block) {
          parts.push(block.text as string)
        }
      }
    }
  }
  const text = parts.join('\n')
  return text.length > MAX_CONVERSATION_TEXT
    ? text.slice(-MAX_CONVERSATION_TEXT)
    : text
}

const SESSION_TITLE_PROMPT = `Generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of this coding session. The title should be clear enough that the user recognizes the session in a list. Use sentence case: capitalize only the first word and proper nouns.

Good examples:
{"title": "Fix login button on mobile"}
{"title": "Add OAuth authentication"}
{"title": "Debug failing CI tests"}
{"title": "Refactor API client error handling"}

Bad (too vague): {"title": "Code changes"}
Bad (too long): {"title": "Investigate and fix the issue where the login button does not respond on mobile devices"}
Bad (wrong case): {"title": "Fix Login Button On Mobile"}`

const titleSchema = lazySchema(() => z.object({ title: z.string() }))

/**
 * Generate a sentence-case session title from a description or first message.
 * Returns null on error or if Haiku returns an unparseable response.
 *
 * @param description - The user's first message or a description of the session
 * @param signal - Abort signal for cancellation
 */
export async function generateSessionTitle(
  description: string,
  signal: AbortSignal,
): Promise<string | null> {
  const trimmed = description.trim()
  if (!trimmed) return null
  let codexConversationIdOverride: string | undefined

  try {
    const structuredOutputSchema = {
      type: 'object',
      properties: {
        title: { type: 'string' },
      },
      required: ['title'],
      additionalProperties: false,
    } as const
    const syntheticOutputResult = createSyntheticOutputTool(structuredOutputSchema)
    if ('error' in syntheticOutputResult) {
      throw new Error(syntheticOutputResult.error)
    }

    const userMessage = createUserMessage({ content: trimmed })
    const model = getSmallFastModelForProvider()
    const provider = resolveRequestProvider(model)
    codexConversationIdOverride =
      provider === 'openai' ? `side/title/${randomUUID()}` : undefined
    const instructionAssembly = buildProviderInstructionAssembly({
      provider,
      messages: [userMessage],
      systemPrompt: asSystemPrompt([SESSION_TITLE_PROMPT]),
      userContext: {},
      systemContext: {},
    })

    const result = await queryModelWithoutStreaming({
      messages: normalizeMessagesForAPI(instructionAssembly.messages),
      systemPrompt: instructionAssembly.systemPrompt,
      openAIInstructionAssembly: instructionAssembly.openAIInstructionAssembly,
      thinkingConfig: { type: 'disabled' },
      tools: [syntheticOutputResult.tool],
      signal,
      options: {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        model,
        provider,
        toolChoice: { type: 'tool', name: SYNTHETIC_OUTPUT_TOOL_NAME },
        agents: [],
        // Reflect the actual session mode — this module is called from
        // both the SDK print path (non-interactive) and the CCR remote
        // session path via useRemoteSession (interactive).
        isNonInteractiveSession: getIsNonInteractiveSession(),
        hasAppendSystemPrompt: false,
        querySource: 'generate_session_title',
        mcpTools: [],
        codexConversationIdOverride,
      },
    })

    const toolUseBlock = result.message.content.find(
      block => block.type === 'tool_use' && block.name === SYNTHETIC_OUTPUT_TOOL_NAME,
    )
    const parsed = titleSchema().safeParse(toolUseBlock?.type === 'tool_use' ? toolUseBlock.input : null)
    const title = parsed.success ? parsed.data.title.trim() || null : null

    logEvent('tengu_session_title_generated', { success: title !== null })

    return title
  } catch (error) {
    logForDebugging(`generateSessionTitle failed: ${error}`, {
      level: 'error',
    })
    logEvent('tengu_session_title_generated', { success: false })
    return null
  } finally {
    if (codexConversationIdOverride) {
      clearWebSocketSession(codexConversationIdOverride)
    }
  }
}
