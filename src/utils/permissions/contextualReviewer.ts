import { createHash } from 'node:crypto'
import { getConfiguredAnthropicProvider, resolveRequestProvider, type APIProvider } from '../model/providers.js'
import { normalizeModelStringForAPI, parseUserSpecifiedModel } from '../model/model.js'
import { buildSideQueryRequest, sideQuery, type SideQueryOptions } from '../sideQuery.js'
import { logForDebugging } from '../debug.js'
import {
  CONTEXTUAL_REVIEW_MAX_BYTES,
  CONTEXTUAL_REVIEW_MAX_OUTPUT,
  CONTEXTUAL_REVIEW_VERSION,
  contextualReviewSystem,
  parseContextualVerdict,
  type ContextualEvidence,
  type ContextualVerdict,
} from './contextualReviewPrompt.js'

export function contextualReviewerProfile(configuredModel: string) {
  const provider = resolveRequestProvider(configuredModel, getConfiguredAnthropicProvider())
  const model = normalizeModelStringForAPI(parseUserSpecifiedModel(configuredModel, provider))
  return { provider, model, effort: 'provider-default' as const }
}

function reviewHistory(entries: ContextualEvidence['conversation']) {
  return entries.flatMap(row => {
    // Selected-option entries are assistant prose. Coordinator correspondence
    // shares that origin but is identified separately by the engine.
    if (row.origin === 'assistant' && row.actor !== 'coordinator') return []
    if (!row.proposal || row.proposal.text.length <= 2_000) return [row]
    return [{ ...row, proposal: { ...row.proposal, text: row.proposal.text.slice(-2_000), truncated: true as const } }]
  })
}

function trimEarlierScriptCells(action: ContextualEvidence['action'], overflow: number): ContextualEvidence['action'] {
  if (!action.script) return action
  const { earlierSources = [], earlierCells = [], ...current } = action.script
  const total = earlierSources.length + earlierCells.length
  if (!total) return action
  const scriptBudget = Buffer.byteLength(JSON.stringify(action.script)) - overflow

  function trim(count: number) {
    // Source goes first. A receipt can still establish what actually ran.
    const sourcesDropped = Math.min(count, earlierSources.length)
    const receiptsDropped = count - sourcesDropped
    return {
      ...current,
      ...(sourcesDropped < earlierSources.length && { earlierSources: earlierSources.slice(sourcesDropped) }),
      ...(sourcesDropped > 0 && { earlierSourcesOmitted: sourcesDropped }),
      ...(receiptsDropped < earlierCells.length && { earlierCells: earlierCells.slice(receiptsDropped) }),
      ...(receiptsDropped > 0 && { earlierCellsOmitted: true as const }),
    }
  }

  let min = 1
  let max = total
  while (min < max) {
    const count = Math.floor((min + max) / 2)
    if (Buffer.byteLength(JSON.stringify(trim(count))) <= scriptBudget) max = count
    else min = count + 1
  }
  return { ...action, script: trim(min) }
}

function fitReviewEvidence(evidence: ContextualEvidence, budget: number): string | undefined {
  const { workspaceInstructions, assignment, toolDescription, agentStatedPurpose,
    recentShellRuns, priorDecisions } = evidence
  const parent = reviewHistory(assignment?.parent ?? [])
  const conversation = reviewHistory(evidence.conversation)
  const entries = [...parent, ...conversation]

  function serialize(
    parentRows: ContextualEvidence['conversation'],
    rows: ContextualEvidence['conversation'],
    omittedHistoryEntries: number,
    action: ContextualEvidence['action'],
  ) {
    return JSON.stringify({
      workspaceInstructions: workspaceInstructions ?? '',
      conversation: rows,
      omittedHistoryEntries,
      assignment: assignment?.parent ? { ...assignment, parent: parentRows } : assignment,
      action, toolDescription, agentStatedPurpose,
      recentShellRuns, priorDecisions,
    })
  }

  const full = serialize(parent, conversation, 0, evidence.action)
  const overflow = Buffer.byteLength(full) - budget
  if (overflow <= 0) return full

  const action = trimEarlierScriptCells(evidence.action, overflow)
  let omitted = entries.length
  let remaining = budget - Buffer.byteLength(serialize([], [], omitted, action))
  if (remaining < 0) return undefined

  const retained = new Set<number>()
  const sizes = { parent: 0, conversation: 0 }
  function keep(index: number): boolean {
    if (retained.has(index)) return true
    const row = entries[index]!
    const section = index < parent.length ? 'parent' : 'conversation'
    const bytes = Buffer.byteLength(JSON.stringify(row)) + (sizes[section] > 0 ? 1 : 0) +
      String(omitted - 1).length - String(omitted).length
    if (bytes > remaining) return false
    retained.add(index)
    sizes[section]++
    remaining -= bytes
    omitted--
    return true
  }

  const newestOperator = entries.findLastIndex(row => row.origin === 'operator')
  if (newestOperator >= 0 && !keep(newestOperator)) return undefined
  const firstOperator = entries.findIndex(row => row.origin === 'operator')
  if (firstOperator >= 0) keep(firstOperator)
  for (let index = entries.length - 1; index >= 0; index--) {
    if (!keep(index)) break
  }

  return serialize(
    parent.filter((_, index) => retained.has(index)),
    conversation.filter((_, index) => retained.has(parent.length + index)),
    omitted,
    action,
  )
}

export function buildContextualReview(
  evidence: ContextualEvidence,
  profile: { model: string; provider: APIProvider },
  instructions?: unknown,
  scriptCell = false,
): { options: SideQueryOptions; requestDigest: string; promptDigest: string } | undefined {
  const system = contextualReviewSystem(evidence.action.tool, instructions, scriptCell)
  const budget = CONTEXTUAL_REVIEW_MAX_BYTES - Buffer.byteLength(system)
  const content = fitReviewEvidence(evidence, budget)
  if (content === undefined) return undefined
  const options: SideQueryOptions = {
    ...profile,
    system,
    messages: [{ role: 'user', content }],
    querySource: 'auto_mode',
    skipSystemPromptPrefix: true,
    max_tokens: CONTEXTUAL_REVIEW_MAX_OUTPUT,
    maxRetries: 0,
    contextualAutoReview: true,
  }
  const digest = (value: string) => createHash('sha256').update(value).digest('hex')
  return { options, requestDigest: digest(JSON.stringify(buildSideQueryRequest(options, profile.provider))), promptDigest: digest(system) }
}

export type ContextualReviewResult =
  | { status: 'valid'; verdict: ContextualVerdict }
  | { status: 'invalid' | 'unavailable' | 'cancelled' }

export async function sendContextualReview(
  options: SideQueryOptions,
  signal: AbortSignal,
  send: typeof sideQuery = sideQuery,
): Promise<ContextualReviewResult> {
  if (signal.aborted) return { status: 'cancelled' }
  const started = performance.now()
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(45_000)])
  let result: ContextualReviewResult
  try {
    const response = await send({ ...options, signal: deadline })
    const text = response.content.filter(block => block.type === 'text').map(block => block.text).join('')
    const verdict = response.stop_reason === 'end_turn' || response.stop_reason === 'stop_sequence'
      ? parseContextualVerdict(text) : undefined
    result = verdict ? { status: 'valid', verdict } : { status: 'invalid' }
  } catch {
    result = { status: 'unavailable' }
  }
  if (signal.aborted) result = { status: 'cancelled' }
  else if (deadline.aborted) result = { status: 'unavailable' }
  logForDebugging(`[contextual-auto-review] model=${options.model} provider=${options.provider} version=${CONTEXTUAL_REVIEW_VERSION} effort=provider-default status=${result.status} durationMs=${Math.round(performance.now() - started)}`)
  return result
}
