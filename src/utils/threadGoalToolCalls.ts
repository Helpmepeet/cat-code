import type { Message } from '../types/message.js'
import type { ThreadGoalToolCall } from './threadGoalRepetition.js'

/**
 * Extract this turn's completed tool calls from engine messages.
 *
 * Shared so the terminal and headless runtimes judge repetition from the same
 * shape the app runtime does. A call is only included once its RESULT has
 * arrived: a call still in flight has no identity yet, and pairing it with an
 * absent result would make two different calls look identical.
 */
export function collectThreadGoalToolCalls(
  messages: readonly Message[],
): ThreadGoalToolCall[] {
  const uses = new Map<string, { toolName: string; input: unknown }>()
  const results = new Map<string, unknown>()

  for (const message of messages) {
    if (message.type !== 'assistant' && message.type !== 'user') continue
    const content = (message as { message?: { content?: unknown } }).message
      ?.content
    if (!Array.isArray(content)) continue

    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const typed = block as Record<string, unknown>
      if (typed.type === 'tool_use' && typeof typed.id === 'string') {
        uses.set(typed.id, {
          toolName: typeof typed.name === 'string' ? typed.name : 'unknown',
          input: typed.input,
        })
      } else if (
        typed.type === 'tool_result' &&
        typeof typed.tool_use_id === 'string'
      ) {
        results.set(typed.tool_use_id, typed.content)
      }
    }
  }

  const calls: ThreadGoalToolCall[] = []
  for (const [id, use] of uses) {
    if (!results.has(id)) continue
    calls.push({ toolName: use.toolName, input: use.input, result: results.get(id) })
  }
  return calls
}
