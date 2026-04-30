import { randomUUID } from 'crypto'

import { CodexCoreError } from './errors.js'
import type {
  CodexCoreMessage,
  RunCodexLLMInput,
} from './types.js'

export type CodexCoreRequest = {
  requestBody: Record<string, unknown>
  conversationId: string
  messagesForNextTurn: CodexCoreMessage[]
}

export function buildCodexCoreRequest(
  options: RunCodexLLMInput,
  model: string,
  conversationId = options.conversationId?.trim() || randomUUID(),
): CodexCoreRequest {
  const normalizedMessages = normalizeCodexCoreMessages(options)
  const systemPrompt = options.systemPrompt
  const hasSystemPrompt = typeof systemPrompt === 'string' && systemPrompt.trim().length > 0
  const messagesForNextTurn = hasSystemPrompt
    ? [
        { role: 'system' as const, content: systemPrompt },
        ...normalizedMessages,
      ]
    : normalizedMessages
  const { instructions, developerContext, inputMessages } = splitPromptMessages(
    normalizedMessages,
    systemPrompt,
  )

  return {
    conversationId,
    messagesForNextTurn,
    requestBody: {
      model,
      stream: true,
      output_config: options.reasoningEffort
        ? { effort: options.reasoningEffort }
        : undefined,
      _openaiInstructionAssembly: {
        instructions,
        developerContext,
        inputMessages,
      },
    },
  }
}

export function normalizeCodexCoreMessages(
  options: Pick<RunCodexLLMInput, 'input' | 'messages'>,
): CodexCoreMessage[] {
  if (options.input !== undefined && options.messages !== undefined) {
    throw new CodexCoreError(
      'invalid_request',
      'Provide either input or messages, not both',
    )
  }

  if (options.input !== undefined) {
    const input = options.input.trim()
    if (!input) {
      throw new CodexCoreError('invalid_request', 'input is required')
    }
    return [{ role: 'user', content: input }]
  }

  const messages = options.messages ?? []
  if (messages.length === 0) {
    throw new CodexCoreError('invalid_request', 'messages is required')
  }

  return messages.map((message, index) => validateMessage(message, index))
}

type SplitPromptMessagesResult = {
  instructions: string
  developerContext?: string
  inputMessages: Array<{ role: 'user' | 'assistant'; content: string }>
}

function splitPromptMessages(
  messages: CodexCoreMessage[],
  systemPrompt?: string,
): SplitPromptMessagesResult {
  const instructions: string[] = []
  const developer: string[] = []
  const inputMessages: Array<{ role: 'user' | 'assistant'; content: string }> = []
  let sawConversationMessage = false
  let sawUserMessage = false

  if (typeof systemPrompt === 'string' && systemPrompt.trim().length > 0) {
    instructions.push(systemPrompt)
  }

  for (const message of messages) {
    if (message.role === 'system') {
      if (sawConversationMessage) {
        throw new CodexCoreError(
          'invalid_request',
          'System messages must appear before user or assistant messages',
        )
      }
      instructions.push(message.content)
      continue
    }

    if (message.role === 'developer') {
      if (sawConversationMessage) {
        throw new CodexCoreError(
          'invalid_request',
          'Developer messages must appear before user or assistant messages',
        )
      }
      developer.push(message.content)
      continue
    }

    if (!sawConversationMessage && message.role !== 'user') {
      throw new CodexCoreError(
        'invalid_request',
        'Conversation history must start with a user message',
      )
    }
    sawConversationMessage = true
    if (message.role === 'user') {
      sawUserMessage = true
    }
    inputMessages.push({
      role: message.role,
      content: message.content,
    })
  }

  if (!sawUserMessage) {
    throw new CodexCoreError(
      'invalid_request',
      'messages must include at least one user message',
    )
  }

  return {
    instructions: instructions.join('\n\n'),
    developerContext: developer.length > 0 ? developer.join('\n\n') : undefined,
    inputMessages,
  }
}

function validateMessage(message: CodexCoreMessage, index: number): CodexCoreMessage {
  if (!message || typeof message !== 'object') {
    throw new CodexCoreError('invalid_request', `messages[${index}] is invalid`)
  }

  if (
    message.role !== 'system' &&
    message.role !== 'developer' &&
    message.role !== 'user' &&
    message.role !== 'assistant'
  ) {
    throw new CodexCoreError(
      'invalid_request',
      `messages[${index}].role must be system, developer, user, or assistant`,
    )
  }

  if (typeof message.content !== 'string' || message.content.trim().length === 0) {
    throw new CodexCoreError(
      'invalid_request',
      `messages[${index}].content must be a non-empty string`,
    )
  }

  return {
    role: message.role,
    content: message.content,
  }
}
