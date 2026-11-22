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
  // Operator rows include verified human answers and corrections. Keep those
  // intact along with the assignment anchor, or hold the action if they do not fit.
  const removable = [
    ...parent.filter(row => row.origin !== 'operator' && row.id !== assignment?.parentAnchor),
    ...conversation.filter(row => row.origin !== 'operator'),
  ]
  function contentAfterRemoving(count: number) {
    const removed = new Set(removable.slice(0, count))
    return JSON.stringify({
      ...evidence,
      assignment: assignment?.parent ? { ...assignment, parent: parent.filter(row => !removed.has(row)) } : assignment,
      conversation: [
        { origin: 'other', text: 'Some conversation entries were omitted to fit the Auto Mode review limit.' },
        ...conversation.filter(row => !removed.has(row)),
      ],
    })
  }

  let start = 1
  let end = removable.length
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
