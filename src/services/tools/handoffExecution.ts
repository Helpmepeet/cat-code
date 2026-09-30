import type { UUID } from 'crypto'
import type { AssistantMessage, UserMessage } from '../../types/message.js'
import { createUserMessage } from '../../utils/messages.js'

export function createHandoffSkippedResult(toolUseId: string, assistant: AssistantMessage): UserMessage {
  return createUserMessage({
    content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: true,
      content: 'This tool was not executed because the conversation is changing workspace.' }],
    toolUseResult: 'Not executed: workspace handoff accepted',
    sourceToolAssistantUUID: assistant.uuid as UUID,
  })
}
