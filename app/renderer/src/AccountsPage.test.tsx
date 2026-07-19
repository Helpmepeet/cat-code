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
  deleteVerb,
  renameError,
  resultToastTone,
  selectAccountMenuItems,
  statusDotTone,
  switchVerb,
  usageTone,
} from './AccountsPage.js'

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
  expect(html).toContain('Waiting for the engine')
  expect(html).not.toContain('MOCK')
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
