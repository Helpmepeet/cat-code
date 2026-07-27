import { afterEach, describe, expect, mock, test } from 'bun:test'
import { PassThrough } from 'stream'
import stripAnsi from 'strip-ansi'
import * as React from 'react'

import { render, ThemeProvider } from '../../ink.js'

const fetchPoolUsage = mock(async () => ({
  accounts: [],
  errors: [],
  fetchedAt: Date.now(),
}))
const fetchUtilization = mock(async () => ({
  five_hour: {
    utilization: 14,
    resets_at: new Date(Date.now() + 3_600_000).toISOString(),
  },
  seven_day: {
    utilization: 27,
    resets_at: new Date(Date.now() + 86_400_000).toISOString(),
  },
  seven_day_sonnet: null,
  extra_usage: null,
}))

await mock.module('../../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 120, rows: 40 }),
}))
await mock.module('../../keybindings/useKeybinding.js', () => ({
  useKeybinding: () => undefined,
}))
await mock.module('../ConfigurableShortcutHint.js', () => ({
  ConfigurableShortcutHint: () => null,
}))
await mock.module('../../services/api/usage.js', () => ({
  fetchUtilization,
}))
await mock.module('../../utils/auth.js', () => ({
  getSubscriptionType: () => 'pro',
  isClaudeAISubscriber: () => true,
}))
await mock.module('../../commands/extra-usage/index.js', () => ({
  extraUsage: { isEnabled: () => false },
}))
await mock.module('../LogoV2/OverageCreditUpsell.js', () => ({
  isEligibleForOverageCreditGrant: () => false,
  OverageCreditUpsell: () => null,
}))
await mock.module('../../services/api/codexAccountPool.js', () => ({
  describeCodexAccountAvailability: () => 'Available',
  getPoolStatus: () => ({
    accounts: [{ accountId: 'main-account', status: 'healthy' }],
    activeIndex: 0,
    initialized: true,
  }),
  hasAnyPoolAccount: () => true,
}))
await mock.module('../../services/api/codexAccountLeaseManager.js', () => ({
  getCodexLeaseSnapshot: () => ({ mainLease: { accountId: 'main-account' } }),
}))
await mock.module('../../services/api/codexUsage.js', () => ({
  buildPoolUsageDisplayAccounts: () => [{
    accountId: 'main-account',
    alias: 'main',
    isActive: true,
    status: 'healthy',
    switchable: true,
    availabilityWarnings: [],
    usage: {
      accountId: 'main-account',
      userId: 'user-1',
      email: 'user@example.test',
      planType: 'plus',
      allowed: true,
      limitReached: false,
      primaryWindow: {
        usedPercent: 32,
        limitWindowSeconds: 18_000,
        resetAfterSeconds: 4_320,
        resetAt: Math.floor(Date.now() / 1000) + 4_320,
      },
      secondaryWindow: {
        usedPercent: 6,
        limitWindowSeconds: 604_800,
        resetAfterSeconds: 561_600,
        resetAt: Math.floor(Date.now() / 1000) + 561_600,
      },
      hasSecondaryWindow: true,
      credits: { hasCredits: false, unlimited: false, balance: '0' },
      fetchedAt: Date.now(),
    },
    error: null,
  }],
  fetchPoolUsage,
  isFreePlan: () => false,
  sortPoolUsageDisplayAccounts: (accounts: unknown[]) => accounts,
}))

async function renderUsage(): Promise<string> {
  const { Usage } = await import('./Usage.js')
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
    columns: number
  }
  stdout.columns = 120
  let output = ''
  ;(stdout as unknown as PassThrough).on('data', chunk => {
    output += chunk.toString()
  })
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & {
    isTTY: boolean
    setRawMode: (enabled: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => undefined
  stdin.ref = () => undefined
  stdin.unref = () => undefined
  const stderr = new PassThrough() as unknown as NodeJS.WriteStream

  const instance = await render(
    <ThemeProvider>
      <Usage />
    </ThemeProvider>,
    {
      stdout,
      stdin,
      stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )

  await new Promise(resolve => setTimeout(resolve, 30))
  instance.unmount()
  return stripAnsi(output)
}

afterEach(() => {
  fetchPoolUsage.mockClear()
  fetchUtilization.mockClear()
})

describe('/usage provider display', () => {
  test('renders Anthropic subscription usage and Codex pool usage together', async () => {
    const output = await renderUsage()

    expect(fetchPoolUsage).toHaveBeenCalledTimes(1)
    expect(fetchUtilization).toHaveBeenCalledTimes(1)
    expect(output).toContain('Anthropic subscription')
    expect(output).toContain('Current session')
    expect(output).toContain('14% used')
    expect(output).toContain('Current week (all models)')
    expect(output).toContain('27% used')
    expect(output).toContain('Codex accounts')
    expect(output).toContain('main · Available')
    expect(output).toContain('32% used')
    expect(output).toContain('6% used')
    expect(output).not.toContain('Usage data is temporarily unavailable')
  })
})
