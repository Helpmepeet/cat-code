import type { AccountStatus } from '../../shared/protocol.js'
import { useEffect, useState } from 'react'

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
  now = Date.now(),
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
    if (account.usageStale &&
      (candidate.resetAt == null || candidate.resetAt * 1000 <= now)) continue
    if (candidate.duration === FIVE_HOUR_WINDOW_SECONDS) {
      fiveHour ??= { percent: candidate.percent, resetAt: candidate.resetAt ?? null }
    } else if (candidate.duration === WEEKLY_WINDOW_SECONDS) {
      weekly ??= { percent: candidate.percent, resetAt: candidate.resetAt ?? null }
    }
  }

  return { fiveHour, weekly }
}

/** Expire saved readings even when a refresh is offline or a view stays open. */
export function useAccountUsageWindows(account: AccountStatus): WelcomeUsageWindows {
  const [, setNow] = useState(0)
  useEffect(() => {
    if (!account.usageStale) return
    const now = Date.now()
    const resets = [account.usageResetAt, account.usageWeeklyResetAt]
      .filter((reset): reset is number => reset != null && reset * 1000 > now)
    if (resets.length === 0) return
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(Math.min(...resets) * 1000 - now + 1, 2_147_483_647),
    )
    return () => clearTimeout(timer)
  })
  return selectWelcomeUsageWindows(account)
}
