import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AccountsSnapshot, AccountStatus } from '../../shared/protocol.js'
import { LeaseRoster } from './LeaseRoster.js'

/**
 * SSR string assertions + the pure `accountsState` selectors (covered in
 * accountsState.test.ts) — the established convention for this renderer (no DOM
 * harness). The Leases tab reuses the P4-5 accounts read-seam, so these tests
 * cover the honest degradation: it renders the real pool, never a mock lease map.
 */
function account(over: Partial<AccountStatus> = {}): AccountStatus {
  return {
    id: 'acct-1',
    alias: 'primary',
    status: 'healthy',
    statusReason: null,
    availability: 'available',
    availabilityLabel: 'Ready',
    isDefault: false,
    hasVaultProfile: true,
    source: 'vault',
    usagePrimary: 12,
    usageWeekly: 30,
    usageLimitReached: false,
    usageResetAt: null,
    lastRefreshIso: null,
    lastError: null,
    planType: 'pro',
    switchable: true,
    ...over,
  }
}

function snapshot(accounts: AccountStatus[]): AccountsSnapshot {
  return {
    accounts,
    activeAccountId: accounts.find(a => a.isDefault)?.id ?? null,
    readyCount: accounts.filter(a => a.status === 'healthy' && !a.usageLimitReached).length,
    poolCount: accounts.length,
    initialized: true,
  }
}

test('empty pool renders the honest "no active leases" state, not a mock roster', () => {
  const html = renderToStaticMarkup(<LeaseRoster snapshot={null} />)
  expect(html).toContain('No active leases')
  expect(html).toContain('Agents lease a Codex account when they run')
  // No fabricated owners / failover events (D2 C5 — no mock lease data).
  expect(html).not.toContain('failed over')
})

test('renders the real pool with the ready label and the active account flagged', () => {
  const html = renderToStaticMarkup(
    <LeaseRoster
      snapshot={snapshot([
        account({ id: 'a1', alias: 'primary', isDefault: true }),
        account({ id: 'a2', alias: 'backup', usagePrimary: 55 }),
      ])}
    />,
  )
  expect(html).toContain('primary')
  expect(html).toContain('backup')
  expect(html).toContain('Accounts in the pool')
  expect(html).toContain('2 of 2 ready')
  expect(html).toContain('active') // isDefault badge
  expect(html).toContain('55%')
})
