/**
 * P4-50 (O2a) — the account-health banner derivation.
 *
 * Ruled 2026-07-31 (`docs/migration/decisions/STARTUP-GATES.md`, the #12
 * revision): account/quota diagnostics get a pinned, dismissable, non-blocking
 * bar above the transcript, because the only place they surfaced before was a
 * notice INSIDE the scrolling transcript, which scrolls away while later turns
 * keep failing. #12 itself is unchanged: nothing here blocks submit, nothing
 * here carries re-auth wall semantics, and no dismissal is persisted.
 *
 * WHY THIS TRIGGER. The banner does not re-derive who can serve a request —
 * that judgment is the engine's `getCodexAccountAvailability()`, projected
 * verbatim into `AccountStatus.availability` at the sidecar
 * (`app/sidecar/accountsDomain.ts:388`). Every account `blocked` means the next
 * Codex request has nothing left to fail over to, which is the state the user
 * is being told about. One account still available means the pool absorbs the
 * cap on its own, and a bar over the transcript would be noise.
 *
 * WHY TWO VARIANTS. `emitCodexUnavailableDiagnostic`
 * (`src/services/api/client.ts:197-207`) splits the same situation in two, and
 * pins the split deliberately: *"only a fully capped pool means wait-for-reset;
 * a dead or unconfigured pool needs repair"* (`client.ts:227-229`). This mirrors
 * that split rather than inventing a second opinion, so the bar and the engine's
 * own terminal error can never disagree about what the user should do. The
 * engine's third code, `auth.missing` (no accounts at all), is deliberately NOT
 * a banner here: that is first-run setup, not a pool that stopped working, and
 * it already has its own surfaces.
 */

import type { AccountsSnapshot, AccountStatus } from '../../shared/protocol.js'
import type { BannerNotice } from './BannerStack.js'
import { formatResetLabel } from './accountsPageModel.js'

/**
 * The banner id doubles as the dismissal signature (see `App.tsx`): dismissing
 * one variant never suppresses the other, so an escalation from a limit that
 * heals itself to a pool that needs the user is always shown.
 */
export const ACCOUNT_HEALTH_CAPACITY_ID = 'account-health:capacity'
export const ACCOUNT_HEALTH_SIGNIN_ID = 'account-health:signin'

/** The one action both variants offer: navigate, never act (no session needed). */
export const ACCOUNT_HEALTH_ACTION_KEY = 'open-accounts'

/**
 * The earliest known reset across the pool, or null when none is known.
 * `usageResetAt` is Unix SECONDS with `0` as the "unknown" sentinel
 * (`src/services/api/codexAccountPool.ts:1495-1497`), so 0 is filtered out
 * rather than formatted.
 */
function earliestReset(accounts: readonly AccountStatus[]): number | null {
  let earliest: number | null = null
  for (const account of accounts) {
    const reset = account.usageResetAt
    if (reset == null || reset <= 0) continue
    if (earliest == null || reset < earliest) earliest = reset
  }
  return earliest
}

/**
 * The account-health bar for a pool snapshot, or null when nothing is worth
 * interrupting for. Pure: pass `now` to pin the reset wording in a test.
 */
export function selectAccountHealthBanner(
  snapshot: AccountsSnapshot | null,
  now = Date.now(),
): BannerNotice | null {
  if (!snapshot) return null
  // An uninitialized pool has not finished reporting; a bar raised on it would
  // flash on every launch, which is the nagware half of the dismissal question.
  if (!snapshot.initialized) return null
  const accounts = snapshot.accounts
  if (accounts.length === 0) return null
  if (!accounts.every(account => account.availability === 'blocked')) return null

  const actions = [{ key: ACCOUNT_HEALTH_ACTION_KEY, label: 'Open Accounts' }]

  if (accounts.every(account => account.status === 'capped')) {
    const reset = earliestReset(accounts)
    return {
      id: ACCOUNT_HEALTH_CAPACITY_ID,
      tone: 'warn',
      title: 'Codex usage limit reached',
      detail:
        reset == null
          ? 'Sending will keep failing until an account resets.'
          : `Sending will keep failing until an account resets. The first one is back ${formatResetLabel(reset, now)}.`,
      actions,
      dismissable: true,
    }
  }

  return {
    id: ACCOUNT_HEALTH_SIGNIN_ID,
    tone: 'danger',
    title: 'No Codex account is ready to use',
    detail: 'Sending will keep failing until an account recovers.',
    actions,
    dismissable: true,
  }
}
