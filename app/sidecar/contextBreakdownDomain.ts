/**
 * Context-breakdown read-seam — the per-category occupancy the terminal's
 * `/context` visualizes, projected onto the composer donut's popover (the
 * prototype's `ContextChip` stacked bar + legend, `Surfaces.jsx:517-537`).
 *
 * The analysis is the engine's OWN `analyzeContextUsage`
 * (`src/utils/analyzeContext.ts:923`), reached through an injectable executor
 * seam exactly like `sessionActionsDomain`/`runControlsDomain`. The sidecar does
 * not count a single token itself (mistakes #1/#10): re-deriving "how big is the
 * system prompt" here would drift from the number `/context` prints for the same
 * session the moment either side changed.
 *
 * The real executor mirrors `/context`'s own call (`src/commands/context/
 * context.tsx:29-56`) argument for argument, including the two transforms that
 * run BEFORE it — `getMessagesAfterCompactBoundary` then `microcompactMessages`
 * — because those are what make the totals describe what the API actually sees
 * rather than the raw transcript. Skipping them overcounts by however much was
 * compacted away.
 *
 * The one deliberate difference from `/context`: messages come from
 * `loadConversationForResume` (the loader the sidecar's resume and its export
 * verb already use) rather than a live REPL array, because the sidecar has no
 * REPL. That is a turn-boundary read of the same transcript the engine just
 * wrote, which is why this seam is computed at turn end and not mid-stream.
 *
 * Failure posture: display = degrade gracefully. `snapshot()` returns null on any
 * failure (no transcript yet, an analyzer throw) and the popover simply renders
 * without a breakdown, never a fabricated one and never a crashed connection.
 */

import type { ContextBreakdownSnapshot } from '../shared/protocol.js'
import { getSessionId } from '../../src/bootstrap/state.js'
import type { Tools, ToolPermissionContext } from '../../src/Tool.js'
import type { AgentDefinitionsResult } from '../../src/tools/AgentTool/loadAgentsDir.js'
import { analyzeContextUsage } from '../../src/utils/analyzeContext.js'
import { loadConversationForResume } from '../../src/utils/conversationRecovery.js'
import { getMessagesAfterCompactBoundary } from '../../src/utils/messages.js'
import { microcompactMessages } from '../../src/services/compact/microCompact.js'

/** The engine call this domain is a thin projection of. Injectable for tests. */
export type ContextBreakdownExecutor = {
  /**
   * Run the engine's real context analysis for THIS session, or return null when
   * there is nothing to analyse yet (no persisted transcript).
   */
  analyze(): Promise<ContextBreakdownSnapshot | null>
}

export function createRealContextBreakdownExecutor(deps: {
  tools: Tools
  agentDefinitions: AgentDefinitionsResult
  getToolPermissionContext: () => ToolPermissionContext
  /** The session's current main-loop model (the run-controls truth). */
  getMainLoopModel: () => string
  /** The same mcpClients the query engine was configured with. */
  getMcpClients: () => unknown[]
}): ContextBreakdownExecutor {
  return {
    async analyze() {
      const loaded = await loadConversationForResume(getSessionId(), undefined)
      const messages = loaded?.messages ?? []
      if (messages.length === 0) return null

      // `/context`'s `toApiView` + microcompact, so the totals describe the API
      // view rather than the raw transcript (context.tsx:16-27, :43).
      const apiView = getMessagesAfterCompactBoundary(messages)
      const { messages: compacted } = await microcompactMessages(apiView)

      const permissionContext = deps.getToolPermissionContext()
      const data = await analyzeContextUsage(
        compacted,
        deps.getMainLoopModel(),
        async () => permissionContext,
        deps.tools,
        deps.agentDefinitions,
        undefined, // terminalWidth — grid layout only, unused here
        // Only `options.mcpClients` is read for the system-prompt build
        // (analyzeContext.ts:958); the sidecar has no LocalJSXCommandContext.
        { options: { mcpClients: deps.getMcpClients() } } as never,
        undefined, // mainThreadAgentDefinition
        apiView, // originals, for API-usage extraction
      )

      return {
        categories: data.categories.map(category => ({
          label: category.name,
          tokens: category.tokens,
          colorKey: String(category.color),
          deferred: category.isDeferred === true,
        })),
        usedTokens: data.totalTokens,
        contextWindow: data.maxTokens,
        model: data.model,
      }
    },
  }
}

export type SidecarContextBreakdownDomain = {
  /** The current breakdown, or null when it cannot be produced. */
  snapshot(): Promise<ContextBreakdownSnapshot | null>
}

export function createSidecarContextBreakdownDomain(options: {
  executor: ContextBreakdownExecutor
  onError?: (error: unknown) => void
}): SidecarContextBreakdownDomain {
  return {
    async snapshot() {
      try {
        return await options.executor.analyze()
      } catch (error) {
        options.onError?.(error)
        return null
      }
    },
  }
}
