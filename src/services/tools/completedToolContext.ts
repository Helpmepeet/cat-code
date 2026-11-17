import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AssistantMessage, Message } from '../../types/message.js'

/** Permission evidence collected only after a tool has finished producing results. */
export class CompletedToolContext {
  private messages: Message[] = []

  constructor(private readonly canUseTool: CanUseToolFn) {}

  readonly checkPermission: CanUseToolFn = (tool, input, context, ...args) => {
    if (!this.messages.length) return this.canUseTool(tool, input, context, ...args)
    const existing = new Set(context.messages.map(message => message.uuid))
    return this.canUseTool(tool, input, {
      ...context,
      messages: [...context.messages, ...this.messages.filter(message => !existing.has(message.uuid))],
    }, ...args)
  }

  record(toolUse: ToolUseBlock, assistant: AssistantMessage, results: Message[]): void {
    // A generator that exits without a paired result has not supplied evidence
    // of a completed call. In particular, never publish its pending siblings.
    if (!results.some(message => message.type === 'user' &&
      Array.isArray(message.message.content) && message.message.content.some(block =>
        block.type === 'tool_result' && block.tool_use_id === toolUse.id))) return
    const priorIndex = this.messages.findIndex(message => message.uuid === assistant.uuid)
    const prior = this.messages[priorIndex]
    if (prior?.type === 'assistant') {
      this.messages[priorIndex] = { ...prior, message: {
        ...prior.message, content: [...prior.message.content, toolUse],
      } }
    } else {
      this.messages.push({ ...assistant, message: { ...assistant.message, content: [toolUse] } })
    }
    // Keep refusal/answer envelopes; ordinary output is excluded by the
    // classifier projection. Newly discovered instructions join the original
    // result stream, but must wait for the next main-model request before
    // entering this temporary same-response evidence overlay.
    this.messages.push(...results.filter(message => message.type !== 'progress' &&
      !(message.type === 'attachment' && typeof message.attachment === 'object' &&
        message.attachment !== null && 'type' in message.attachment &&
        message.attachment.type === 'nested_memory')))
  }
}
