import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
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

// bun never unregisters a `mock.module`, and `mock.restore()` does not undo one
// either, so every registration below stays installed for the rest of the test
// process. `active` is true only while this file's own tests run; outside that
// window each override delegates to the real implementation, which is what stops
// this file's Codex fixture from bleeding into later files (it used to replace
// LogoV2.test.tsx's seeded pool with the single "main" account below).
let active = false

// `mock.module` MUTATES the namespace object a prior `import` returned, so a
// pass-through that reads the export off the namespace at call time would call
// the mock itself and recurse forever. Capture every implementation up front.
const terminalSizeModule = await import('../../hooks/useTerminalSize.js')
const keybindingModule = await import('../../keybindings/useKeybinding.js')
const shortcutHintModule = await import('../ConfigurableShortcutHint.js')
const usageApiModule = await import('../../services/api/usage.js')
const authModule = await import('../../utils/auth.js')
const extraUsageModule = await import('../../commands/extra-usage/index.js')
const upsellModule = await import('../LogoV2/OverageCreditUpsell.js')
const poolModule = await import('../../services/api/codexAccountPool.js')
const leaseModule = await import('../../services/api/codexAccountLeaseManager.js')
const codexUsageModule = await import('../../services/api/codexUsage.js')

const real = {
  useTerminalSize: terminalSizeModule.useTerminalSize,
  useKeybinding: keybindingModule.useKeybinding,
  ConfigurableShortcutHint: shortcutHintModule.ConfigurableShortcutHint,
  fetchUtilization: usageApiModule.fetchUtilization,
  getSubscriptionType: authModule.getSubscriptionType,
  isClaudeAISubscriber: authModule.isClaudeAISubscriber,
  extraUsage: extraUsageModule.extraUsage,
  isEligibleForOverageCreditGrant: upsellModule.isEligibleForOverageCreditGrant,
  OverageCreditUpsell: upsellModule.OverageCreditUpsell,
  describeCodexAccountAvailability: poolModule.describeCodexAccountAvailability,
  getPoolStatus: poolModule.getPoolStatus,
  hasAnyPoolAccount: poolModule.hasAnyPoolAccount,
  getCodexLeaseSnapshot: leaseModule.getCodexLeaseSnapshot,
  buildPoolUsageDisplayAccounts: codexUsageModule.buildPoolUsageDisplayAccounts,
  fetchPoolUsage: codexUsageModule.fetchPoolUsage,
  isFreePlan: codexUsageModule.isFreePlan,
  sortPoolUsageDisplayAccounts: codexUsageModule.sortPoolUsageDisplayAccounts,
}

function poolUsageFixture() {
  return [
    {
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
    },
  ]
}

await mock.module('../../hooks/useTerminalSize.js', () => ({
  ...terminalSizeModule,
  useTerminalSize: () =>
    active ? { columns: 120, rows: 40 } : real.useTerminalSize(),
}))
await mock.module('../../keybindings/useKeybinding.js', () => ({
  ...keybindingModule,
  useKeybinding: (...args: Parameters<typeof real.useKeybinding>) =>
    active ? undefined : real.useKeybinding(...args),
}))
await mock.module('../ConfigurableShortcutHint.js', () => ({
  ...shortcutHintModule,
  ConfigurableShortcutHint: (props: Record<string, unknown>) =>
    active ? null : <real.ConfigurableShortcutHint {...props} />,
}))
await mock.module('../../services/api/usage.js', () => ({
  ...usageApiModule,
  fetchUtilization: () =>
    active ? fetchUtilization() : real.fetchUtilization(),
}))
await mock.module('../../utils/auth.js', () => ({
  ...authModule,
  getSubscriptionType: () => (active ? 'pro' : real.getSubscriptionType()),
  isClaudeAISubscriber: () => (active ? true : real.isClaudeAISubscriber()),
}))
await mock.module('../../commands/extra-usage/index.js', () => ({
  ...extraUsageModule,
  extraUsage: {
    ...real.extraUsage,
    isEnabled: () => (active ? false : real.extraUsage.isEnabled()),
  },
}))
await mock.module('../LogoV2/OverageCreditUpsell.js', () => ({
  ...upsellModule,
  isEligibleForOverageCreditGrant: () =>
    active ? false : real.isEligibleForOverageCreditGrant(),
  OverageCreditUpsell: (props: Record<string, unknown>) =>
    active ? null : <real.OverageCreditUpsell {...props} />,
}))
await mock.module('../../services/api/codexAccountPool.js', () => ({
  ...poolModule,
  describeCodexAccountAvailability: (
    ...args: Parameters<typeof real.describeCodexAccountAvailability>
  ) => (active ? 'Available' : real.describeCodexAccountAvailability(...args)),
  getPoolStatus: () =>
    active
      ? {
          accounts: [{ accountId: 'main-account', status: 'healthy' }],
          activeIndex: 0,
          initialized: true,
        }
      : real.getPoolStatus(),
  hasAnyPoolAccount: () => (active ? true : real.hasAnyPoolAccount()),
}))
await mock.module('../../services/api/codexAccountLeaseManager.js', () => ({
  ...leaseModule,
  getCodexLeaseSnapshot: () =>
    active
      ? { mainLease: { accountId: 'main-account' } }
      : real.getCodexLeaseSnapshot(),
}))
await mock.module('../../services/api/codexUsage.js', () => ({
  ...codexUsageModule,
  buildPoolUsageDisplayAccounts: (
    ...args: Parameters<typeof real.buildPoolUsageDisplayAccounts>
  ) =>
    active ? poolUsageFixture() : real.buildPoolUsageDisplayAccounts(...args),
  fetchPoolUsage: (...args: Parameters<typeof real.fetchPoolUsage>) =>
    active ? fetchPoolUsage() : real.fetchPoolUsage(...args),
  isFreePlan: (...args: Parameters<typeof real.isFreePlan>) =>
    active ? false : real.isFreePlan(...args),
  sortPoolUsageDisplayAccounts: (accounts: unknown[]) =>
    active
      ? accounts
      : real.sortPoolUsageDisplayAccounts(
          accounts as Parameters<typeof real.sortPoolUsageDisplayAccounts>[0],
        ),
}))

beforeAll(() => {
  active = true
})

afterAll(() => {
  active = false
})

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
