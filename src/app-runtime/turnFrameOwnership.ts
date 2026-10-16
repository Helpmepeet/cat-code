import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'

/**
 * Which message events are the running parent turn's own activity.
 *
 * Subagent steps are published out of turn (`publishSubagentFrame`), so a
 * worker launched by an earlier turn keeps emitting while a later turn runs.
 * Counting those frames would let an old worker keep a stuck turn looking alive
 * and add its tool calls to the turn's totals.
 *
 * A nested frame belongs to the turn while its parent tool use is pending in
 * that turn. A foreground run stays pending until it returns. A background
 * launch resolves at once with its launch acknowledgement, and a run moved to
 * the background resolves at the move, so their later steps are not the turn's.
 * Top-level frames are always the turn's.
 */
export function createTurnFrameOwnership() {
  const pending = new Set<string>()
  return {
    /** Call at each turn boundary. */
    reset(): void {
      pending.clear()
    },
    /** Track this frame and answer whether it is the current turn's own. */
    observe(message: SDKMessage): boolean {
      const parent = 'parent_tool_use_id' in message ? message.parent_tool_use_id : null
      if (typeof parent === 'string' && parent.length > 0) return pending.has(parent)
      if (message.type !== 'assistant' && message.type !== 'user') return true
      const content: unknown = message.message.content
      if (!Array.isArray(content)) return true
      for (const block of content) {
        if (typeof block !== 'object' || block === null) continue
        const typed = block as { type?: unknown; id?: unknown; tool_use_id?: unknown }
        if (message.type === 'assistant' && typed.type === 'tool_use' && typeof typed.id === 'string') {
          pending.add(typed.id)
        } else if (message.type === 'user' && typed.type === 'tool_result' && typeof typed.tool_use_id === 'string') {
          pending.delete(typed.tool_use_id)
        }
      }
      return true
    },
  }
}

export type TurnFrameOwnership = ReturnType<typeof createTurnFrameOwnership>
