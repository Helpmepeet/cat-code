import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
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

type Entry = ContextualEvidence['conversation'][number]
type ScriptEvidence = NonNullable<ContextualEvidence['action']['script']>

function reviewHistory(entries: ContextualEvidence['conversation'], submissionIds: Map<string, string>) {
  const delivered = new Map<string, Entry>()
  return entries.flatMap(entry => {
    // Selected-option entries are assistant prose. Coordinator correspondence
    // shares that origin but is identified separately by the engine.
    if (entry.origin === 'assistant' && entry.actor !== 'coordinator') return []
    const { submittedId, ...fields } = entry
    const row = submittedId ? { ...fields, id: submittedId } : entry
    if (submittedId) {
      if (entry.id) submissionIds.set(entry.id, submittedId)
      delivered.set(submittedId, row)
    } else if (row.id && isDeepStrictEqual(delivered.get(row.id), row)) {
      // An attachment can become visible just before the queue removes its copy.
      return []
    }
    if (!row.proposal || row.proposal.text.length <= 2_000) return [row]
    return [{ ...row, proposal: { ...row.proposal, text: row.proposal.text.slice(-2_000), truncated: true as const } }]
  })
}

function fitEarlierScriptCells(script: ScriptEvidence, budget: number): ScriptEvidence {
  if (Buffer.byteLength(JSON.stringify(script)) <= budget) return script
  const { earlierSources = [], earlierCells = [], ...current } = script
  const total = earlierSources.length + earlierCells.length
  if (!total) return script

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
    if (Buffer.byteLength(JSON.stringify(trim(count))) <= budget) max = count
    else min = count + 1
  }
  return trim(min)
}

function fitReviewEvidence(evidence: ContextualEvidence, budget: number): string | undefined {
  const { workspaceInstructions, assignment, toolDescription, agentStatedPurpose,
    recentShellRuns, priorDecisions } = evidence
  const submissionIds = new Map<string, string>()
  const parent = reviewHistory(assignment?.parent ?? [], submissionIds)
  const conversation = reviewHistory(evidence.conversation, submissionIds)
  const entries = [...parent, ...conversation]
  const reviewId = (id: string | undefined) => id === undefined ? undefined : submissionIds.get(id) ?? id
  const parentAnchor = reviewId(assignment?.parentAnchor)
  const isAnchor = (row: Entry) => parentAnchor !== undefined && row.origin === 'operator' && row.id === parentAnchor
  const anchorBytes = parentAnchor ? Buffer.byteLength(JSON.stringify({ parentAnchor })) - 1 : 0
  const shellRuns = recentShellRuns?.map(run => ({ ...run, afterOperatorId: reviewId(run.afterOperatorId) }))

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
      assignment: assignment && {
        ...assignment,
        parent: assignment.parent && parentRows,
        parentAnchor: parentRows.some(isAnchor) ? parentAnchor : undefined,
      },
      action, toolDescription, agentStatedPurpose,
      recentShellRuns: shellRuns, priorDecisions,
    })
  }

  const full = serialize(parent, conversation, 0, evidence.action)
  const overflow = Buffer.byteLength(full) - budget
  if (overflow <= 0) return full

  const script = evidence.action.script
  let action = script ? { ...evidence.action,
    script: fitEarlierScriptCells(script, Buffer.byteLength(JSON.stringify(script)) - overflow),
  } : evidence.action
  let omitted = entries.length
  let remaining = budget - Buffer.byteLength(serialize([], [], omitted, action))
  if (remaining < 0) return undefined

  const retained = new Set<number>()
  const sizes = { parent: 0, conversation: 0 }
  let retainedAnchor = false
  function keep(index: number): boolean {
    if (retained.has(index)) return true
    const row = entries[index]!
    const section = index < parent.length ? 'parent' : 'conversation'
    const addsAnchor = section === 'parent' && !retainedAnchor && isAnchor(row)
    const bytes = Buffer.byteLength(JSON.stringify(row)) + (sizes[section] > 0 ? 1 : 0) +
      String(omitted - 1).length - String(omitted).length + (addsAnchor ? anchorBytes : 0)
    if (bytes > remaining) return false
    retained.add(index)
    retainedAnchor ||= addsAnchor
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

  // Whole conversation entries may free more space than the overflow required.
  if (script && action.script && action.script !== script && remaining > 0) {
    const finalScriptBudget = Buffer.byteLength(JSON.stringify(action.script)) + remaining
    action = { ...action, script: fitEarlierScriptCells(script, finalScriptBudget) }
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
