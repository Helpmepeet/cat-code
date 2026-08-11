import { getEmptyToolPermissionContext } from '../../Tool.js'
import { queryModelWithoutStreaming } from '../../services/api/claude.js'
import { buildProviderInstructionAssembly } from '../../services/api/instructionAssembly.js'
import {
  SYNTHETIC_OUTPUT_TOOL_NAME,
  createSyntheticOutputTool,
} from '../../tools/SyntheticOutputTool/SyntheticOutputTool.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import {
  createUserMessage,
  normalizeMessagesForAPI,
} from '../../utils/messages.js'
import { getSmallFastModelForProvider } from '../../utils/model/model.js'
import { resolveRequestProvider } from '../../utils/model/providers.js'
import { extractConversationText } from '../../utils/sessionTitle.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'

export async function generateSessionName(
  messages: Message[],
  signal: AbortSignal,
): Promise<string | null> {
  const conversationText = extractConversationText(messages)
  if (!conversationText) {
    return null
  }

  try {
    const structuredOutputSchema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
      required: ['name'],
      additionalProperties: false,
    } as const
    const syntheticOutputResult = createSyntheticOutputTool(structuredOutputSchema)
    if ('error' in syntheticOutputResult) {
      throw new Error(syntheticOutputResult.error)
    }

    const userMessage = createUserMessage({ content: conversationText })
    const model = getSmallFastModelForProvider()
    const provider = resolveRequestProvider(model)
    const instructionAssembly = buildProviderInstructionAssembly({
      provider,
      messages: [userMessage],
      systemPrompt: asSystemPrompt([
        'Generate a short kebab-case name (2-4 words) that captures the main topic of this conversation. Use lowercase words separated by hyphens. Examples: "fix-login-bug", "add-auth-feature", "refactor-api-client", "debug-test-failures".',
      ]),
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
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
        querySource: 'rename_generate_name',
        mcpTools: [],
      },
    })

    const toolUseBlock = result.message.content.find(
      block => block.type === 'tool_use' && block.name === SYNTHETIC_OUTPUT_TOOL_NAME,
    )
    if (
      toolUseBlock &&
      toolUseBlock.type === 'tool_use' &&
      typeof toolUseBlock.input === 'object' &&
      toolUseBlock.input !== null &&
      'name' in toolUseBlock.input &&
      typeof toolUseBlock.input.name === 'string'
    ) {
      return toolUseBlock.input.name
    }
    return null
  } catch (error) {
    // Haiku timeout/rate-limit/network are expected operational failures —
    // logForDebugging, not logError. Called automatically on every 3rd bridge
    // message (initReplBridge.ts), so errors here would flood the error file.
    logForDebugging(`generateSessionName failed: ${errorMessage(error)}`, {
      level: 'error',
    })
    return null
  }
}
