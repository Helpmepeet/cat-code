/**
 * Plain (React-free) state machine for the Settings Reset tab.
 *
 * The tab (`Reset.tsx`) owns the side effects — token pre-flight,
 * availability fetch, `consumeUsageLimitReset`, and the post-success pool heal.
 * This module owns everything testable: exact copy, account targeting and
 * per-account eligibility, idempotency-key lifetime, and mapping from a
 * `ConsumeResetOutcome` to a result state.
 *
 * Keep this module free of ink/React imports so it can be unit-tested directly.
 */

import { randomUUID } from 'crypto'
import type { ConsumeResetOutcome } from '../../services/api/codexUsage.js'
import {
  getRedemptionEligibility,
  type PoolAccount,
} from '../../services/api/codexAccountPool.js'

// ── Copy ─────────────────────────────────────────────────────────────────────
// Exact strings from the design's copy table. Upstream strings preserved where
// one exists; keep in sync with docs/codex/2026-07-04-usage-reset-design.md.

export const COPY = {
  checking: 'Checking your available resets...',
  checkFailed: "Couldn't load usage limit resets. Please try again.",
  zeroCredits: "You don't have any usage limit resets available.",
  confirmTitle: 'Usage limit resets',
  confirmItemUse: 'Use a reset',
  confirmItemCancel: 'Cancel',
  consuming: 'Resetting your usage...',
  successNoCount: 'Usage reset.',
  nothingToReset: 'Your usage does not need a reset right now.',
  noCredit: 'No usage limit resets are available.',
  consumeError: "Couldn't reset usage. Please try again.",
  tryAgain: 'Try again',
  close: 'Close',
  descMonthly: 'Reset your current monthly usage limit.',
  descRolling: 'Reset your current 5-hour and weekly usage limits.',
} as const

const MONTHLY_WINDOW_SECONDS = 28 * 24 * 60 * 60
const ZERO_CREDITS_DISABLED_REASON = 'no resets available'

export function confirmSubtitle(count: number): string {
  return `You have ${count} usage limit reset${count === 1 ? '' : 's'} available.`
}

export function successWithCount(count: number): string {
  return `Usage reset. You have ${count} usage limit reset${count === 1 ? '' : 's'} left.`
}

export function redeemedTranscript(label: string, leftCount?: number): string {
  return typeof leftCount === 'number'
    ? `Redeemed usage limit reset on ${label} (${leftCount} left)`
    : `Redeemed usage limit reset on ${label}`
}

export function confirmDescription(input: {
  planType?: string
  limitWindowSeconds?: number
}): string {
  const plan = (input.planType ?? '').toLowerCase()
  const isMonthlyPlan = plan === 'free' || plan === 'go'
  const isMonthlyWindow =
    typeof input.limitWindowSeconds === 'number' &&
    input.limitWindowSeconds >= MONTHLY_WINDOW_SECONDS
  return isMonthlyPlan || isMonthlyWindow ? COPY.descMonthly : COPY.descRolling
}

export type RedeemCandidate = {
  accountId: string
  label: string
  email?: string
  isActive: boolean
  status: PoolAccount['status']
  statusReason?: PoolAccount['statusReason']
  resetCreditsAvailable?: number
  planType?: string
  limitWindowSeconds?: number
  disabledReason?: string
}

function labelFor(
  account: Pick<PoolAccount, 'alias' | 'accountId'>,
  email?: string,
): string {
  return account.alias ?? (email && email.length > 0 ? email : account.accountId.slice(0, 12))
}

export function buildCandidates(input: {
  accounts: readonly PoolAccount[]
  activeIndex: number
  usageByAccountId: Map<
    string,
    {
      email?: string
      planType?: string
      resetCreditsAvailable?: number
      limitWindowSeconds?: number
    }
  >
  preflightById?: Map<string, { kind: 'reauth' | 'transient'; message: string }>
}): RedeemCandidate[] {
  const { accounts, activeIndex, usageByAccountId, preflightById } = input
  return accounts.map((account, index) => {
    const usage = usageByAccountId.get(account.accountId)
    const preflight = preflightById?.get(account.accountId)
    const eligibility = getRedemptionEligibility(account)

    let disabledReason: string | undefined
    if (preflight?.kind === 'reauth') {
      disabledReason = 're-login required'
    } else if (eligibility.eligible === false) {
      disabledReason = eligibility.reason
    } else if (usage?.resetCreditsAvailable === 0) {
      disabledReason = ZERO_CREDITS_DISABLED_REASON
    }

    return {
      accountId: account.accountId,
      label: labelFor(account, usage?.email),
      email: usage?.email,
      isActive: index === activeIndex,
      status: account.status,
      statusReason: account.statusReason,
      resetCreditsAvailable: usage?.resetCreditsAvailable,
      planType: usage?.planType,
      limitWindowSeconds: usage?.limitWindowSeconds,
      disabledReason,
    }
  })
}

export function isCandidateEnabled(candidate: RedeemCandidate): boolean {
  return candidate.disabledReason === undefined
}

export function selectDefaultCandidate(
  candidates: readonly RedeemCandidate[],
): RedeemCandidate | undefined {
  const enabled = candidates.filter(isCandidateEnabled)
  const cappedUsage = enabled.find(
    candidate =>
      candidate.status === 'capped' && candidate.statusReason === 'usage_cap',
  )
  if (cappedUsage) return cappedUsage
  const active = enabled.find(candidate => candidate.isActive)
  if (active) return active
  return enabled[0]
}

export function noEligibleReason(candidates: readonly RedeemCandidate[]): string {
  if (
    candidates.length > 0 &&
    candidates.every(candidate => candidate.disabledReason === 're-login required')
  ) {
    return 'All Codex accounts need re-login.'
  }
  if (
    candidates.length > 0 &&
    candidates.every(
      candidate => candidate.disabledReason === ZERO_CREDITS_DISABLED_REASON,
    )
  ) {
    return COPY.zeroCredits
  }
  const firstReason = candidates.find(candidate => candidate.disabledReason)
    ?.disabledReason
  if (firstReason) return firstReason
  return COPY.zeroCredits
}

export function mintRedeemRequestId(): string {
  return randomUUID()
}

export type RedeemResult =
  | { kind: 'success'; windowsReset: number; leftCount?: number }
  | { kind: 'nothing_to_reset' }
  | { kind: 'no_credit' }
  | { kind: 'error' }

export function mapConsumeOutcome(outcome: ConsumeResetOutcome): RedeemResult {
  switch (outcome.kind) {
    case 'reset':
    case 'already_redeemed':
      return { kind: 'success', windowsReset: outcome.windowsReset }
    case 'nothing_to_reset':
      return { kind: 'nothing_to_reset' }
    case 'no_credit':
      return { kind: 'no_credit' }
    case 'http_error':
    case 'invalid_response':
    case 'network_error':
      return { kind: 'error' }
  }
}

export function successMessage(result: {
  kind: 'success'
  leftCount?: number
}): string {
  return typeof result.leftCount === 'number'
    ? successWithCount(result.leftCount)
    : COPY.successNoCount
}
