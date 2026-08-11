import { APIUserAbortError } from '@anthropic-ai/sdk'
import { getEmptyToolPermissionContext } from '../Tool.js'
import type { Message } from '../types/message.js'
import { logForDebugging } from '../utils/debug.js'
import {
  createUserMessage,
  getAssistantMessageText,
  normalizeMessagesForAPI,
} from '../utils/messages.js'
import { getSmallFastModelForProvider } from '../utils/model/model.js'
import { resolveRequestProvider } from '../utils/model/providers.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'
import { buildProviderInstructionAssembly } from './api/instructionAssembly.js'
import { queryModelWithoutStreaming } from './api/claude.js'
import { getSessionMemoryContent } from './SessionMemory/sessionMemoryUtils.js'

// Recap only needs recent context — truncate to avoid "prompt too long" on
// large sessions. 30 messages ≈ ~15 exchanges, plenty for "where we left off."
const RECENT_MESSAGE_WINDOW = 30

function buildAwaySummaryPrompt(memory: string | null): string {
  const memoryBlock = memory
    ? `Session memory (broader context):\n${memory}\n\n`
    : ''
  return `${memoryBlock}The user stepped away and is coming back. Write exactly 1-3 short sentences. Start by stating the high-level task — what they are building or debugging, not implementation details. Next: the concrete next step. Skip status reports and commit recaps.`
}

/**
 * Generates a short session recap for the "while you were away" card.
 * Returns null on abort, empty transcript, or error.
 */
export async function generateAwaySummary(
  messages: readonly Message[],
  signal: AbortSignal,
): Promise<string | null> {
  if (messages.length === 0) {
    return null
  }

  try {
    const memory = await getSessionMemoryContent()
    const recent = messages.slice(-RECENT_MESSAGE_WINDOW)
    recent.push(createUserMessage({ content: buildAwaySummaryPrompt(memory) }))
    const model = getSmallFastModelForProvider()
    const provider = resolveRequestProvider(model)
    // Build a provider-native instruction assembly so the OpenAI/Codex path
    // (the default on the Codex fork) receives the payload translateToCodexBody
    // requires — without it the request throws before being sent. No-op shape
    // for genuine Anthropic providers.
    const assembly = buildProviderInstructionAssembly({
      provider,
      messages: recent,
      systemPrompt: asSystemPrompt([]),
      userContext: {},
      systemContext: {},
    })
    const response = await queryModelWithoutStreaming({
      messages: normalizeMessagesForAPI(assembly.messages),
      systemPrompt: assembly.systemPrompt,
      openAIInstructionAssembly: assembly.openAIInstructionAssembly,
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal,
      options: {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        model,
        provider,
        // disabled thinking lands as undefined on the body and never reaches
        // the Codex adapter, which would then default to high reasoning effort.
        // Pin low effort for this cheap, latency-sensitive recap. No-op on
        // Anthropic (Haiku ignores effort).
        effortValue: 'low',
        toolChoice: undefined,
        isNonInteractiveSession: false,
        hasAppendSystemPrompt: false,
        agents: [],
        querySource: 'away_summary',
        mcpTools: [],
        skipCacheWrite: true,
      },
    })

    if (response.isApiErrorMessage) {
      logForDebugging(
        `[awaySummary] API error: ${getAssistantMessageText(response)}`,
      )
      return null
    }
    return getAssistantMessageText(response)
  } catch (err) {
    if (err instanceof APIUserAbortError || signal.aborted) {
      return null
    }
    logForDebugging(`[awaySummary] generation failed: ${err}`)
    return null
  }
}
