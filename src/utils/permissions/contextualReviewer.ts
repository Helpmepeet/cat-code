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

function trimConversation(evidence: ContextualEvidence, budget: number): string | undefined {
  const { assignment, conversation } = evidence
  const parent = assignment?.parent ?? []
  type Row = ContextualEvidence['conversation'][number]
  const isOperator = (row: Row) => row.origin === 'operator'
  const newest = new Set([parent.findLast(isOperator), conversation.findLast(isOperator)])
  const anchor = assignment?.parentAnchor ? parent.find(row => row.id === assignment.parentAnchor) : undefined
  const rows = [...parent, ...conversation]
  const nonOperator = rows.filter(row => !isOperator(row) && row !== anchor)
  const olderOperators = rows.filter(row => isOperator(row) && !newest.has(row))
  const proposals = olderOperators.filter(row => row.proposal)
  const anchorIndex = anchor ? parent.indexOf(anchor) : -1
  // A parent instruction after the anchor can withdraw it, so never drop one.
  const removableOperators = olderOperators.filter(row => row !== anchor && parent.indexOf(row) <= anchorIndex)

  function contentAfterRemoving(count: number) {
    // Remove lower-priority context before losing any operator text.
    const afterNonOperator = Math.max(0, count - nonOperator.length)
    const removed = new Set([
      ...nonOperator.slice(0, count),
      ...removableOperators.slice(0, Math.max(0, afterNonOperator - proposals.length)),
    ])
    const stripped = new Set(proposals.slice(0, afterNonOperator))
    const retain = (entries: readonly Row[]) => entries
      .filter(row => !removed.has(row))
      .map(row => stripped.has(row) ? { ...row, proposal: undefined } : row)
    return JSON.stringify({
      ...evidence,
      assignment: assignment?.parent ? { ...assignment, parent: retain(parent) } : assignment,
      conversation: [
        { origin: 'other', text: 'Some conversation entries were omitted to fit the Auto Mode review limit.' },
        ...retain(conversation),
      ],
    })
  }

  let start = 1
  let end = nonOperator.length + proposals.length + removableOperators.length
  let result: string | undefined
  while (start <= end) {
    const count = Math.floor((start + end) / 2)
    const content = contentAfterRemoving(count)
    if (Buffer.byteLength(content) <= budget) {
      result = content
      end = count - 1
    } else {
      start = count + 1
    }
  }
  return result
}

export function buildContextualReview(
  evidence: ContextualEvidence,
  profile: { model: string; provider: APIProvider },
  instructions?: unknown,
  trimOlderConversation = false,
): { options: SideQueryOptions; requestDigest: string; promptDigest: string } | undefined {
  const system = contextualReviewSystem(evidence.action.tool, instructions)
  const budget = CONTEXTUAL_REVIEW_MAX_BYTES - Buffer.byteLength(system)
  const fullContent = JSON.stringify(evidence)
  const content = Buffer.byteLength(fullContent) <= budget ? fullContent
    : trimOlderConversation ? trimConversation(evidence, budget) : undefined
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
