import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { getAgentContext, isSubagentContext, type SubagentContext } from './agentContext.js'
import { getAdvisorUsage } from './advisor.js'
import { calculateUSDCost } from './modelCost.js'

type WorkerUsage = {
  usage: Pick<BetaUsage,
    'input_tokens' | 'output_tokens' | 'cache_creation_input_tokens' |
    'cache_read_input_tokens' | 'server_tool_use' | 'service_tier' | 'cache_creation'>
  totalTokens: number
  estimatedCostUSD: number
}

// Each spawn or resume has its own context object. Nested workers get a
// separate context, while compaction and other queries for this run inherit it.
const usageByRun = new WeakMap<SubagentContext, WorkerUsage | undefined>()

export function startWorkerUsage(): void {
  const context = getAgentContext()
  if (isSubagentContext(context)) usageByRun.set(context, undefined)
}

export function recordWorkerUsage(
  usage: BetaUsage | undefined,
  model: string,
  previous?: BetaUsage,
): void {
  const context = getAgentContext()
  if (!isSubagentContext(context) || !usageByRun.has(context) || !usage) return

  if (previous) applyRequestUsage(context, previous, model, -1)
  applyRequestUsage(context, usage, model, 1)
}

function applyRequestUsage(
  context: SubagentContext,
  usage: BetaUsage,
  model: string,
  sign: 1 | -1,
): void {
  addUsage(context, usage, model, sign)
  for (const advisor of getAdvisorUsage(usage)) {
    addUsage(context, advisor, advisor.model, sign)
  }
}

function addUsage(
  context: SubagentContext,
  usage: BetaUsage,
  model: string,
  sign: 1 | -1,
): void {
  const previous = usageByRun.get(context)
  const priorUsage = previous?.usage
  const input = (priorUsage?.input_tokens ?? 0) + sign * usage.input_tokens
  const output = (priorUsage?.output_tokens ?? 0) + sign * usage.output_tokens
  const cacheRead = (priorUsage?.cache_read_input_tokens ?? 0) +
    sign * (usage.cache_read_input_tokens ?? 0)
  const cacheWrite = (priorUsage?.cache_creation_input_tokens ?? 0) +
    sign * (usage.cache_creation_input_tokens ?? 0)
  usageByRun.set(context, {
    usage: {
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheWrite,
      service_tier: null,
      cache_creation: {
        ephemeral_1h_input_tokens: (priorUsage?.cache_creation?.ephemeral_1h_input_tokens ?? 0) +
          sign * (usage.cache_creation?.ephemeral_1h_input_tokens ?? 0),
        ephemeral_5m_input_tokens: (priorUsage?.cache_creation?.ephemeral_5m_input_tokens ?? 0) +
          sign * (usage.cache_creation?.ephemeral_5m_input_tokens ?? 0),
      },
      server_tool_use: {
        web_search_requests: (priorUsage?.server_tool_use?.web_search_requests ?? 0) +
          sign * (usage.server_tool_use?.web_search_requests ?? 0),
        web_fetch_requests: (priorUsage?.server_tool_use?.web_fetch_requests ?? 0) +
          sign * (usage.server_tool_use?.web_fetch_requests ?? 0),
      },
    },
    totalTokens: input + output + cacheRead + cacheWrite,
    estimatedCostUSD: (previous?.estimatedCostUSD ?? 0) + sign * calculateUSDCost(model, usage),
  })
}

export function getWorkerUsage(agentId: string): WorkerUsage | undefined {
  const context = getAgentContext()
  if (isSubagentContext(context) && context.agentId === agentId) {
    return usageByRun.get(context)
  }
}
