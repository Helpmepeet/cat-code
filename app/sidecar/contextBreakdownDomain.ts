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
 * The one deliberate difference from `/context`: messages are re-read from the
 * persisted transcript rather than a live REPL array, because the sidecar has no
 * REPL. That is a read of the same transcript the engine just wrote, so it is
 * current as of the last completed turn.
 *
 * Failure posture: display = degrade gracefully. `snapshot()` returns null on any
 * failure (no transcript yet, an analyzer throw) and the popover simply renders
 * without a breakdown, never a fabricated one and never a crashed connection.
 */

import type { UUID } from 'crypto'
import type { ContextBreakdownSnapshot } from '../shared/protocol.js'
import { getSessionId } from '../../src/bootstrap/state.js'
import type { Tools, ToolPermissionContext, ToolUseContext } from '../../src/Tool.js'
import type { AgentDefinitionsResult } from '../../src/tools/AgentTool/loadAgentsDir.js'
import { analyzeContextUsage } from '../../src/utils/analyzeContext.js'
import { deserializeMessages } from '../../src/utils/conversationRecovery.js'
import {
  getLastSessionLog,
  isLiteLog,
  loadFullLog,
} from '../../src/utils/sessionStorage.js'
import { getMessagesAfterCompactBoundary } from '../../src/utils/messages.js'
import { microcompactMessages } from '../../src/services/compact/microCompact.js'
import { buildDesktopSystemPrompt } from './desktopSystemPrompt.js'

/**
 * Categories `analyzeContextUsage` appends that describe UNUSED window rather
 * than occupancy, and so must never become a legend row or a bar segment:
 * `Free space` (`src/utils/analyzeContext.ts:1183`, pushed unconditionally) and
 * `Autocompact buffer` (`:1166`, the reserved headroom). This is the engine's
 * OWN visibility rule, not an invention: its `/context` renderer filters on
 * exactly these two names (`src/components/ContextVisualization.tsx`,
 * `cat.tokens > 0 && cat.name !== 'Free space' && cat.name !== RESERVED_CATEGORY_NAME`).
 *
 * `Compact buffer` (`:1174`, manual-compact mode) is deliberately NOT here —
 * `/context` shows it, because it is real reserved space the session gave up.
 */
const UNOCCUPIED_CATEGORY_NAMES = new Set(['Free space', 'Autocompact buffer'])

/** The engine's name for the unused remainder (`analyzeContext.ts:1184`). */
const FREE_SPACE_CATEGORY = 'Free space'

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
}): ContextBreakdownExecutor {
  return {
    async analyze() {
      // Deliberately NOT `loadConversationForResume`. The export and branch
      // verbs used to, and were moved onto this same read for these reasons.
      // Despite the name it is not a reader: it runs `processSessionStartHooks`
      // ('resume') — the user's own SessionStart hooks, arbitrary shell — appends
      // their output to the messages, trips `restoreSkillStateFromMessages`'s
      // fire-once `suppressNextSkillListing` latch, and copies plan + file history
      // to disk (`src/utils/conversationRecovery.ts:603-626`). Firing those from a
      // read-only popover in the LIVE process would change what the model sees.
      // `transcriptBackfillWorker.ts:46-50` sets `CLAUDE_CODE_SIMPLE=1` purely to
      // neuter the hook branch for this same call; the live sidecar is not bare,
      // so that mitigation is unavailable here. These three are the loader half of
      // that function's own string-source branch (`:578-590`), with none of the tail.
      const log = await getLastSessionLog(getSessionId() as UUID)
      if (!log) return null
      const full = isLiteLog(log) ? await loadFullLog(log) : log
      const messages = deserializeMessages(full.messages ?? [])
      if (messages.length === 0) return null

      // `/context`'s `toApiView` + microcompact, so the totals describe the API
      // view rather than the raw transcript (context.tsx:16-27, :43). `toApiView`
      // also applies `projectView` under `feature('CONTEXT_COLLAPSE')`, which is
      // absent from the dev-full feature list, so there is nothing to mirror.
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
        // `analyzeContextUsage` reads only a few fields off this argument —
        // `options.mcpClients`, `options.customSystemPrompt`,
        // `options.appendSystemPrompt` and `options.mainLoopProvider` — all
        // through `?.`, but its signature
        // declares the full `Pick<ToolUseContext, 'options'>`
        // (`context-noninteractive.ts` stubs the same fields for the same
        // reason). `mcpClients` stays `[]` and there is still no
        // `customSystemPrompt` in the sidecar's engine config, but
        // `appendSystemPrompt` is not empty: the controller sets it to
        // `buildDesktopSystemPrompt()` (`sessionController.ts`), and
        // `analyzeContext.ts` feeds it into `buildEffectiveSystemPrompt`,
        // whose output is what `countSystemTokens` measures. This calls that
        // same builder rather than restating part of it: naming the addendum
        // alone was a second expression of the prompt, and it drifted the moment
        // the peer doctrine was appended, reporting 275 of 1254 characters for a
        // named session with a creator. Anything less than the assembled prompt
        // undercounts system tokens by exactly what it leaves out.
        {
          options: {
            mcpClients: [],
            appendSystemPrompt: buildDesktopSystemPrompt(),
          },
        } as unknown as Pick<ToolUseContext, 'options'>,
        undefined, // mainThreadAgentDefinition
        apiView, // originals, for API-usage extraction
      )

      return projectContextBreakdown(data)
    },
  }
}

/** The engine output this projection reads. A structural subset of `ContextData`
 * so a fixture can exercise it without constructing the whole analysis. */
export type ContextBreakdownInput = {
  categories: readonly {
    name: string
    tokens: number
    color: unknown
    isDeferred?: boolean
  }[]
  totalTokens: number
  maxTokens: number
  model: string
}

/**
 * `ContextData` → the wire snapshot. Exported and pure so the category filter is
 * unit-testable against realistic engine output: the executor around it can only
 * be exercised against a live engine, which is exactly how the `Free space` leak
 * shipped unnoticed.
 */
export function projectContextBreakdown(
  data: ContextBreakdownInput,
): ContextBreakdownSnapshot {
  const freeSpace = data.categories.find(
    category => category.name === FREE_SPACE_CATEGORY,
  )

  return {
    categories: data.categories
      .filter(category => !UNOCCUPIED_CATEGORY_NAMES.has(category.name))
      .map(category => ({
        label: category.name,
        tokens: category.tokens,
        colorKey: String(category.color),
        deferred: category.isDeferred === true,
      })),
    usedTokens: data.totalTokens,
    // The engine's OWN remainder, not `contextWindow - usedTokens`: those two
    // disagree, because `totalTokens` is the API's fresh-input count when one
    // is available and only falls back to the category sum otherwise
    // (`analyzeContext.ts:1199-1204`), while `Free space` is computed from the
    // category sum and the reserved buffer (`:1181`). Subtracting would print a
    // `Free` that does not reconcile with the bar beside it.
    freeTokens: freeSpace?.tokens ?? null,
    contextWindow: data.maxTokens,
    model: data.model,
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
