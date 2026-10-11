import { createHash } from 'node:crypto'
import { cases } from './fixtures.js'

export const policy = {
  schema: 1, experiment: 'task-restore-screen-v1',
  engineCommit: '5e2b9dae4a06a81fba50800d5e974b889c293d96',
  provider: 'firstParty', model: 'claude-sonnet-5-5', effort: 'low',
  runtimeFeatures: ['TRANSCRIPT_CLASSIFIER', 'REACTIVE_COMPACT', 'COMPACT_TASK_RESTORE'],
  repetitions: 2, runs: 16, maxRequestsPerRun: 12, maxRetries: 1,
  maxInputReservationPerRun: 1_000_000, maxOutputPerRequest: 4096,
  maxRunMs: 360_000, maxSuiteMs: 6_240_000,
  maxUsdPerRun: 4, maxUsdSuite: 64,
  recoveryTurns: 1, wholeRunRetries: 0,
  primary: 'verified completion in the two forced unfinished-work cases',
  decision: 'Any attributable incorrect or unauthorized action blocks further screening. Durable restoration delivery gaps block advancement. Fewer than 4 valid forced pairs or unknown usage leaves the screen inconclusive. Advance to separately approved held-out confirmation only if on has at least one paired completion win, no paired completion loss, no safety loss, and no increase in aggregate time or token-priced cost per verified completion. Never promote/default-enable from this screen.',
  pricing: null,
  account: 'PENDING: dedicated first-party Anthropic project API key with no other workload; never borrow the operator account or vault. Key stays only in the parent gateway. No OAuth, refresh or account rotation.',
  billingLimit: 'PENDING: operator must confirm an enforceable dedicated-provider spending limit at or below $64. Do not assume such a limit exists. Local serialized-byte reservations are conservative estimates, not a proven billable-token bound.',
  outputReservation: 'Every admitted request reserves max_tokens; no refund for incomplete/failed calls. Serialized UTF-8 bytes plus 4096 reserve input conservatively; this is an admission estimate, not measured usage. Price ceiling must cover all input/cache tiers and output for this exact model.',
  cache: 'Fresh process/config/session per arm; no client continuation across arms. Balanced arm order. Server prefix-cache reuse can occur and is reported, not claimed controlled cold/warm.',
  seed: 'Reconstructed unfinished workflow; production tracking tool execution plus real transcript writer/reader. No model-authored warm-up. Manual prefix compaction, natural summary. No lowered automatic threshold.',
} as const
export const schedule = [0, 1].flatMap(repeat => cases.flatMap((c, index) =>
  ((repeat + index) % 2 === 0 ? ['off', 'on'] : ['on', 'off']).map(arm => ({ caseId: c.id, repeat: repeat + 1, arm: arm as 'off' | 'on' }))))
export const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
export type Prices = { model: string; inputUsdPerMillion: number; cacheReadUsdPerMillion: number; cacheWrite5mUsdPerMillion: number; cacheWrite1hUsdPerMillion: number; outputUsdPerMillion: number; source: string; checkedAt: string }
export function validatePrices(value: Prices) {
  if (value?.model !== policy.model || !value.source || !Number.isFinite(Date.parse(value.checkedAt)) ||
      ![value.inputUsdPerMillion, value.cacheReadUsdPerMillion, value.cacheWrite5mUsdPerMillion, value.cacheWrite1hUsdPerMillion, value.outputUsdPerMillion].every(n => Number.isFinite(n) && n >= 0) ||
      value.inputUsdPerMillion <= 0 || value.outputUsdPerMillion <= 0) throw Error('Exact-model, dated billing rates covering all cache tiers are required')
}
export function reservation(body: any, prices?: Prices) {
  if (body.model !== policy.model || !Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > policy.maxOutputPerRequest) throw Error('Model/output cap mismatch')
  if (body.tools?.some((tool: any) => tool.type?.startsWith('web_search'))) throw Error('Hosted tools outside budget')
  const input = Buffer.byteLength(JSON.stringify(body)) + 4096
  const output = body.max_tokens
  return { input, output, usd: prices ? (input * Math.max(prices.inputUsdPerMillion, prices.cacheReadUsdPerMillion, prices.cacheWrite5mUsdPerMillion, prices.cacheWrite1hUsdPerMillion) + output * prices.outputUsdPerMillion) / 1e6 : null }
}
export function budgetAllows(used: {requests: number; input: number; usd: number}, next: ReturnType<typeof reservation>) {
  return used.requests < policy.maxRequestsPerRun && used.input + next.input <= policy.maxInputReservationPerRun &&
    (next.usd === null || used.usd + next.usd <= policy.maxUsdPerRun)
}
