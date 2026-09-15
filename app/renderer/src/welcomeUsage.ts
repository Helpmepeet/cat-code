import type { AccountStatus } from '../../shared/protocol.js'

const FIVE_HOUR_WINDOW_SECONDS = 18_000
const WEEKLY_WINDOW_SECONDS = 604_800

type WelcomeUsageWindow = {
  percent: number | null
  resetAt: number | null
}

export type WelcomeUsageWindows = {
  fiveHour: WelcomeUsageWindow | null
  weekly: WelcomeUsageWindow | null
}

/** Resolve the upstream usage positions into the welcome table's named slots. */
export function selectWelcomeUsageWindows(
  account: AccountStatus,
): WelcomeUsageWindows {
  const candidates = [
    {
      duration: account.usagePrimaryWindowSeconds,
      percent: account.usagePrimary,
      resetAt: account.usageResetAt,
    },
    {
      duration: account.usageSecondaryWindowSeconds,
      percent: account.usageWeekly,
      resetAt: account.usageWeeklyResetAt ?? null,
    },
  ]

  let fiveHour: WelcomeUsageWindow | null = null
  let weekly: WelcomeUsageWindow | null = null
  for (const candidate of candidates) {
    if (candidate.duration === FIVE_HOUR_WINDOW_SECONDS) {
      fiveHour ??= { percent: candidate.percent, resetAt: candidate.resetAt ?? null }
    } else if (candidate.duration === WEEKLY_WINDOW_SECONDS) {
      weekly ??= { percent: candidate.percent, resetAt: candidate.resetAt ?? null }
    }
  }

  return { fiveHour, weekly }
}
