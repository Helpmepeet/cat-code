import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  AccountResultFrame,
  AccountsSnapshot,
  AccountStatus,
  AccountVerbMessage,
} from '../../shared/protocol.js'
import {
  AccountsPage,
} from './AccountsPage.js'
import {
  deleteVerb,
  loginVerb,
  renameError,
  resultToastTone,
  selectAccountMenuItems,
  selectAnthropicReadyLabel,
  statusDotTone,
  statusLabelTone,
  switchVerb,
  usageTone,
} from './accountsPageModel.js'

/**
 * This package has NO DOM test harness — `bun test` exposes no `document`/`window`,
 * `react-dom/client` is not installed, and neither `@testing-library/react` nor
 * happy-dom/jsdom is a dependency (adding one needs sign-off). Every sibling
 * renderer test uses `renderToStaticMarkup` (SSR string) + pure exported helpers
 * (tone.ts, toastReducer). This file follows that real convention: SSR for
 * render/degrade assertions, and the interaction-bearing logic is factored into
 * pure exported helpers (menu gating, verb builders, result-tone) tested directly
 * — the exact code path the click handlers run. Live click/effect behavior (a
 * dialog closing on the matching `account.result`) is exercised in the running
 * app; here it is covered at the logic seam.
 */

function account(overrides: Partial<AccountStatus> = {}): AccountStatus {
  return {
    id: 'acc-1',
    alias: 'work-laptop',
    status: 'healthy',
    statusReason: null,
    availability: 'available',
    availabilityLabel: 'Ready',
    isDefault: false,
    hasVaultProfile: true,
    source: 'vault',
    usagePrimary: 42,
    usageWeekly: 70,
    usageLimitReached: false,
    usageResetAt: null,
    lastRefreshIso: null,
    lastError: null,
    planType: 'plus',
    switchable: true,
    ...overrides,
  }
}

function snapshot(accounts: AccountStatus[]): AccountsSnapshot {
  const readyCount = accounts.filter(
    a => a.status === 'healthy' && !a.usageLimitReached,
  ).length
  return {
    accounts,
    activeAccountId: accounts.find(a => a.isDefault)?.id ?? null,
    readyCount,
    poolCount: accounts.length,
    initialized: true,
    anthropicAccounts: [],
    anthropicActiveAccountId: null,
    anthropicReadyCount: 0,
    anthropicPoolCount: 0,
    anthropicInitialized: true,
    anthropicRouteAvailable: false,
  }
}

const noop = () => {}

/* ── (a) renders the pool rows + ready label ── */

test('renders the pool rows and the ready label from a snapshot', () => {
  const snap = snapshot([
    account({ id: 'acc-1', alias: 'primary', isDefault: true, switchable: false }),
    account({ id: 'acc-2', alias: 'backup' }),
  ])
  const html = renderToStaticMarkup(
    <AccountsPage snapshot={snap} lastResult={null} onVerb={noop} />,
  )
  expect(html).toContain('Accounts')
  expect(html).toContain('Codex Pool')
  expect(html).toContain('2 of 2 ready')
  expect(html).toContain('primary')
  expect(html).toContain('backup')
  expect(html).toContain('active') // default-account badge
  expect(html).not.toContain('MOCK')
})

/* ── (b) menu gating on the real redacted fields ── */

test('menu shows Switch only when switchable', () => {
  expect(
    selectAccountMenuItems(account({ switchable: true })).map(i => i.key),
  ).toContain('switch')
  expect(
    selectAccountMenuItems(account({ switchable: false })).map(i => i.key),
  ).not.toContain('switch')
})

test('menu shows Rename and Delete only when hasVaultProfile', () => {
  const withVault = selectAccountMenuItems(
    account({ hasVaultProfile: true }),
  ).map(i => i.key)
  expect(withVault).toContain('rename')
  expect(withVault).toContain('delete')

  const configOnly = selectAccountMenuItems(
    account({ hasVaultProfile: false, source: 'config' }),
  ).map(i => i.key)
  expect(configOnly).not.toContain('rename')
  expect(configOnly).not.toContain('delete')
})

test('menu shows Sign out only when isDefault', () => {
  expect(
    selectAccountMenuItems(account({ isDefault: true })).map(i => i.key),
  ).toContain('logout')
  expect(
    selectAccountMenuItems(account({ isDefault: false })).map(i => i.key),
  ).not.toContain('logout')
})

/* ── (c) Switch dispatches account.switch with the account id ── */

test('switchVerb builds an account.switch verb for the target account', () => {
  const verb: AccountVerbMessage = switchVerb('acc-42')
  expect(verb.type).toBe('account.switch')
  expect(verb).toMatchObject({ type: 'account.switch', accountId: 'acc-42' })
  expect(typeof verb.requestId).toBe('string')
  expect(verb.requestId.length).toBeGreaterThan(0)
})

test('switchVerb can address the Anthropic account pool', () => {
  expect(switchVerb('claude-42', 'anthropic')).toMatchObject({
    type: 'account.switch',
    accountId: 'claude-42',
    provider: 'anthropic',
  })
})

test('loginVerb addresses the selected provider', () => {
  expect(loginVerb('anthropic')).toMatchObject({
    type: 'account.login',
    provider: 'anthropic',
  })
  expect(loginVerb('openai')).toMatchObject({
    type: 'account.login',
    provider: 'openai',
  })
})

test('renders the redacted Anthropic pool alongside Codex', () => {
  const snap = snapshot([])
  snap.anthropicAccounts = [
    {
      id: 'claude-1',
      alias: 'personal',
      email: 'claude@example.com',
      status: 'healthy',
      isDefault: true,
      hasVaultProfile: true,
      subscriptionType: 'pro',
    },
  ]
  snap.anthropicActiveAccountId = 'claude-1'
  snap.anthropicReadyCount = 1
  snap.anthropicPoolCount = 1

  const html = renderToStaticMarkup(
    <AccountsPage snapshot={snap} lastResult={null} onVerb={noop} />,
  )
  expect(html).toContain('Anthropic Pool')
  expect(html).toContain('claude@example.com')
  expect(html).toContain('personal')
  expect(html).toContain('1 of 1 ready')
})

test('presents a configured non-pool Anthropic route honestly', () => {
  const snap = snapshot([])
  snap.anthropicRouteAvailable = true

  expect(selectAnthropicReadyLabel(snap)).toBe('route configured')
  const html = renderToStaticMarkup(
    <AccountsPage snapshot={snap} lastResult={null} onVerb={noop} />,
  )
  expect(html).toContain('route configured')
  expect(html).toContain(
    'Anthropic route configured through an API key or cloud provider.',
  )
  expect(html).not.toContain('No Anthropic accounts linked yet.')
})

test('an unhealthy active Anthropic account shows health over plan decoration', () => {
  const snap = snapshot([])
  snap.anthropicAccounts = [
    {
      id: 'claude-dead',
      alias: 'expired',
      email: 'expired@example.com',
      status: 'dead',
      isDefault: true,
      hasVaultProfile: true,
      subscriptionType: 'max',
    },
  ]
  snap.anthropicActiveAccountId = 'claude-dead'
  snap.anthropicPoolCount = 1

  const html = renderToStaticMarkup(
    <AccountsPage snapshot={snap} lastResult={null} onVerb={noop} />,
  )
  expect(html).toContain('bg-tone-danger')
  expect(html).toContain('>dead<')
  expect(html).not.toContain('>max<')
})

/* ── (d) Delete dispatches account.delete with confirm:true ── */

test('deleteVerb builds an account.delete verb with confirm true', () => {
  const verb = deleteVerb('acc-9')
  expect(verb).toMatchObject({
    type: 'account.delete',
    accountId: 'acc-9',
    confirm: true,
  })
  expect(typeof verb.requestId).toBe('string')
})

/* ── (e) a null snapshot renders a degraded state without throwing ── */

test('a null snapshot renders the waiting state without throwing', () => {
  const html = renderToStaticMarkup(
    <AccountsPage snapshot={null} lastResult={null} onVerb={noop} />,
  )
  expect(html).toContain('Accounts')
  expect(html).toContain('Loading accounts')
  expect(html).not.toContain('MOCK')
  // CLAUDE.md §7 — the empty state must not print internal vocabulary at the
  // user (the copy it replaced named the sidecar and the prototype fixtures).
  for (const leak of ['sidecar', 'prototype', 'redacted', 'snapshot']) {
    expect(html).not.toContain(leak)
  }
})

/* ── (f) result correlation → toast tone; page accepts a lastResult prop ── */

test('resultToastTone maps ok/err to success/danger', () => {
  expect(resultToastTone(true)).toBe('success')
  expect(resultToastTone(false)).toBe('danger')
})

test('renders with a lastResult prop present without throwing', () => {
  const result: AccountResultFrame = {
    kind: 'account.result',
    protocolVersion: 1,
    sessionId: 'sess-1',
    requestId: 'req-1',
    verb: 'account.switch',
    ok: true,
    message: 'Switched to backup',
  }
  const html = renderToStaticMarkup(
    <AccountsPage
      snapshot={snapshot([account()])}
      lastResult={result}
      onVerb={noop}
    />,
  )
  expect(html).toContain('Codex Pool')
})

/* ── cap banner + supporting helpers ── */

test('renders the usage-limit cap banner for a capped account', () => {
  const snap = snapshot([
    account({ id: 'acc-1', alias: 'primary', isDefault: true, switchable: false }),
    account({
      id: 'acc-2',
      alias: 'burned',
      status: 'capped',
      switchable: false,
      usageLimitReached: true,
      availabilityLabel: 'Usage limit hit',
    }),
  ])
  const html = renderToStaticMarkup(
    <AccountsPage snapshot={snap} lastResult={null} onVerb={noop} />,
  )
  expect(html).toContain('usage limit reached')
  expect(html).toContain('Switch to another account or wait for the reset')
})

test('statusDotTone mirrors the prototype POOL_STATUS colours (capped/dead not swapped)', () => {
  // pressured (healthy + usage-capped) → warn, before any status/default check
  expect(statusDotTone(account({ status: 'healthy', usageLimitReached: true }))).toBe(
    'warn',
  )
  // active/default account → accent (pink), regardless of a healthy status
  expect(statusDotTone(account({ isDefault: true }))).toBe('accent')
  expect(statusDotTone(account({ status: 'healthy', isDefault: false }))).toBe('good')
  // the previously-swapped pair: capped is red (danger), dead is yellow (warn)
  expect(statusDotTone(account({ status: 'capped', isDefault: false }))).toBe('danger')
  expect(statusDotTone(account({ status: 'dead', isDefault: false }))).toBe('warn')
  // quarantined is a transient grey, not yellow
  expect(statusDotTone(account({ status: 'quarantined', isDefault: false }))).toBe(
    'default',
  )
})

test('statusLabelTone follows pure status colour with NO default→accent override', () => {
  // The active/default account's LABEL reads its status, not pink — decoupled from
  // the DOT (prototype Pages.jsx:417 label vs :409 dot).
  expect(statusLabelTone(account({ status: 'healthy', isDefault: true }))).toBe('good')
  expect(statusLabelTone(account({ status: 'capped', isDefault: true }))).toBe('danger')
  expect(statusLabelTone(account({ status: 'dead', isDefault: false }))).toBe('warn')
  expect(statusLabelTone(account({ status: 'quarantined', isDefault: false }))).toBe(
    'default',
  )
  // pressured (healthy + usage-capped) still leads to warn
  expect(
    statusLabelTone(account({ status: 'healthy', usageLimitReached: true })),
  ).toBe('warn')
})

test('the active/default account label follows status colour, not the pink dot tone', () => {
  // #14 minor: the availability label reused the dot tone, so the active account
  // read PINK. It must follow pure status (green healthy) while the dot stays pink.
  const snap = snapshot([
    account({ id: 'acc-1', alias: 'primary', isDefault: true, availabilityLabel: 'Ready' }),
  ])
  const html = renderToStaticMarkup(
    <AccountsPage snapshot={snap} lastResult={null} onVerb={noop} />,
  )
  // Label 'Ready' is painted status-good (green), NOT accent-pink.
  expect(html).toContain('text-tone-good">Ready')
  expect(html).not.toContain('text-accent">Ready')
  // The hero dot keeps the pink-for-default override.
  expect(html).toMatch(/h-\[9px\] w-\[9px\][^"]*bg-accent/)
})

test('a capped account that is ALSO the default renders a pink dot (precedence) with a red label', () => {
  // Precedence: isDefault beats status for the DOT (pink), while the LABEL follows
  // pure status (red = capped). Both in one capped+default hero row.
  const snap = snapshot([
    account({
      id: 'acc-1',
      alias: 'burned',
      status: 'capped',
      isDefault: true,
      switchable: false,
      usageLimitReached: true,
      availabilityLabel: 'Usage limit hit',
    }),
  ])
  const html = renderToStaticMarkup(
    <AccountsPage snapshot={snap} lastResult={null} onVerb={noop} />,
  )
  // Hero dot is pink (accent) even though the account is capped.
  expect(html).toMatch(/h-\[9px\] w-\[9px\][^"]*bg-accent/)
  // The availability label reads its true status (danger/red), not pink.
  expect(html).toContain('text-tone-danger">Usage limit hit')
})

test('the weekly headroom bar is blank while the 5h bar shows the ↺ reset (single usageResetAt)', () => {
  // §0 DATA GAP: the wire carries ONE usageResetAt (the 5h window), so the ↺-reset
  // indicator shows on the 5h bar and is left blank on the weekly bar — never faked.
  const snap = snapshot([
    account({
      id: 'acc-1',
      alias: 'primary',
      // non-default so no hero / ActiveHeadroom header ↺ pollutes the count.
      isDefault: false,
      usagePrimary: 42,
      usageWeekly: 70,
      usageResetAt: Math.floor(Date.now() / 1000) + 3 * 3600,
      availabilityLabel: 'Ready',
    }),
  ])
  const html = renderToStaticMarkup(
    <AccountsPage snapshot={snap} lastResult={null} onVerb={noop} />,
  )
  // Exactly one ↺: the 5h bar. The weekly bar's reset slot is blank.
  expect((html.match(/↺/g) ?? []).length).toBe(1)
  expect(html).toContain('↺ in')
})

test('usageTone thresholds: ≥90 danger, ≥65 warn, else good', () => {
  expect(usageTone(95)).toBe('danger')
  expect(usageTone(90)).toBe('danger')
  expect(usageTone(70)).toBe('warn')
  expect(usageTone(65)).toBe('warn')
  expect(usageTone(10)).toBe('good')
  expect(usageTone(null)).toBe('good')
})

test('renameError enforces the alias regex + uniqueness (excluding self)', () => {
  expect(renameError('', 'old', [])).toBe('Alias required')
  expect(renameError('has spaces', 'old', [])).not.toBeNull()
  expect(renameError('bad!', 'old', [])).not.toBeNull()
  expect(renameError('taken', 'old', ['taken'])).toBe(
    'That alias is already in use',
  )
  // renaming to its own current alias is allowed
  expect(renameError('old', 'old', ['old'])).toBeNull()
  expect(renameError('fresh-name_1', 'old', ['taken'])).toBeNull()
})

test('AccountsPage renders Usage Analytics section and 7d/30d global toggle buttons', () => {
  const snap = snapshot([account({ id: 'acc-1', isDefault: true })])
  const html = renderToStaticMarkup(
    <AccountsPage snapshot={snap} lastResult={null} onVerb={noop} />,
  )
  expect(html).toContain('Usage Analytics')
  expect(html).toContain('7 Days')
  expect(html).toContain('30 Days')
  expect(html).toContain('Prompt Caching')
})

test('AccountsPage renders real token counts from usageStats', () => {
  const snap = snapshot([account({ id: 'acc-1', isDefault: true })])
  const realStats = {
    range: '7d' as const,
    totalTokens: 2260000,
    dailyModelTokens: [
      { date: '2026-08-13', tokensByModel: { 'claude-3-5-sonnet': 1000000 } },
      { date: '2026-08-14', tokensByModel: { 'claude-3-5-sonnet': 1260000 } },
    ],
    modelUsage: {
      'claude-3-5-sonnet': {
        inputTokens: 1500000,
        outputTokens: 760000,
        cacheCreationInputTokens: 200000,
        cacheReadInputTokens: 8000000,
      },
    },
    dailyActivity: [
      { date: '2026-08-13', messageCount: 200, sessionCount: 5, toolCallCount: 10 },
      { date: '2026-08-14', messageCount: 300, sessionCount: 8, toolCallCount: 15 },
    ],
    cacheHitRate: 82,
    cacheReadTokens: 8000000,
    cacheWriteTokens: 200000,
    freshInputTokens: 1500000,
    totalSessions: 13,
    totalMessages: 500,
    activeDays: 2,
  }

  const html = renderToStaticMarkup(
    <AccountsPage
      snapshot={snap}
      lastResult={null}
      usageStats={realStats}
      activeStatsRange="7d"
      onVerb={noop}
    />,
  )

  expect(html).toContain('2.26M') // totalTokens in 7d
  expect(html).toContain('82%') // cacheHitRate
  expect(html).toContain('Claude 3.5 Sonnet')
  expect(html).toContain('13') // total sessions
  expect(html).toContain('500 msgs')
})

test('AccountsPage honestly renders empty usage state when 0 sessions exist in window', () => {
  const snap = snapshot([account({ id: 'acc-1', isDefault: true })])
  const emptyStats = {
    range: '7d' as const,
    totalTokens: 0,
    dailyModelTokens: [],
    modelUsage: {},
    dailyActivity: [],
    cacheHitRate: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    freshInputTokens: 0,
    totalSessions: 0,
    totalMessages: 0,
    activeDays: 0,
  }

  const html = renderToStaticMarkup(
    <AccountsPage
      snapshot={snap}
      lastResult={null}
      usageStats={emptyStats}
      activeStatsRange="7d"
      onVerb={noop}
    />,
  )

  expect(html).toContain('No session activity recorded')
  expect(html).toContain('No model activity in this period.')
})

