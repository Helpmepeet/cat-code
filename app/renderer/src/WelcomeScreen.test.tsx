import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { WelcomeScreen } from './WelcomeScreen.js'
import type { RecentWorkspace } from './sessionsCatalogState.js'
import type { AccountsSnapshot, AccountStatus } from '../../shared/protocol.js'

function recent(over: Partial<RecentWorkspace> & { cwd: string }): RecentWorkspace {
  return {
    name: over.cwd.split('/').pop() ?? over.cwd,
    appSessionId: null,
    live: false,
    modifiedAtMs: Date.now(),
    trusted: null,
    sessionCount: 1,
    ...over,
  }
}

function account(over: Partial<AccountStatus> & { id: string }): AccountStatus {
  return {
    alias: over.id,
    status: 'healthy',
    statusReason: null,
    availability: 'available',
    availabilityLabel: 'Ready',
    isDefault: false,
    hasVaultProfile: true,
    source: 'vault',
    usagePrimary: 0,
    usageWeekly: 0,
    usageLimitReached: false,
    usageResetAt: null,
    lastRefreshIso: null,
    lastError: null,
    planType: 'plus',
    switchable: false,
    ...over,
  }
}

function pool(accounts: AccountStatus[]): AccountsSnapshot {
  return {
    accounts,
    activeAccountId: accounts.find(a => a.isDefault)?.id ?? null,
    readyCount: accounts.filter(a => a.status === 'healthy' && !a.usageLimitReached).length,
    poolCount: accounts.length,
    initialized: true,
  }
}

const noop = () => {}

test('renders the hero wordmark, greeting and meta strip labels', () => {
  const html = renderToStaticMarkup(
    <WelcomeScreen
      recents={[recent({ cwd: '/w/cat-code', appSessionId: 'a', live: true })]}
      accounts={pool([account({ id: 'main', alias: 'main', isDefault: true })])}
      orchestratorActive={false}
      onOpenRecent={noop}
      onOpenFolder={noop}
    />,
  )
  expect(html).toContain('cat ')
  expect(html).toContain('code')
  expect(html).toContain('Welcome back')
  expect(html).toContain('Project')
  expect(html).toContain('Start in')
  expect(html).toContain('Orchestrator')
  expect(html).toContain('Locally')
  // The picker trigger reflects the most-recent project name.
  expect(html).toContain('cat-code')
})

test('the branch chooser + worktree option are CUT (absent)', () => {
  const html = renderToStaticMarkup(
    <WelcomeScreen
      recents={[]}
      accounts={null}
      orchestratorActive={false}
      onOpenRecent={noop}
      onOpenFolder={noop}
    />,
  )
  expect(html).not.toContain('Worktree')
  expect(html).not.toContain('worktree')
  expect(html).not.toContain('Branch')
  expect(html).not.toContain('feat/cat-launcher')
  // With no recents the trigger invites a first project instead of a mock path.
  expect(html).toContain('Open a project')
})

test('the Codex table renders real pool rows (alias, capped badge, usage %)', () => {
  const html = renderToStaticMarkup(
    <WelcomeScreen
      recents={[]}
      accounts={pool([
        account({ id: 'main', alias: 'main', isDefault: true, usagePrimary: 20, usageWeekly: 40 }),
        account({ id: 'b', alias: 'backup', status: 'capped', usageLimitReached: true, usagePrimary: 100 }),
      ])}
      orchestratorActive={false}
      onOpenRecent={noop}
      onOpenFolder={noop}
    />,
  )
  expect(html).toContain('Codex')
  expect(html).toContain('>2</span> accounts')
  // Prototype header: status-`healthy` count labelled "healthy" (main is healthy,
  // backup is capped → 1).
  expect(html).toContain('>1</span> healthy')
  expect(html).toContain('main')
  expect(html).toContain('backup')
  expect(html).toContain('capped')
  expect(html).toContain('20%')
  expect(html).toContain('100%')
  // Prototype grammar: flat pink gradient bars, not tone-coded green/amber/red.
  expect(html).toContain('from-[#f9a8d4] to-[#ec4899]')
  // No "5h"/"wk" text labels in the prototype rows.
  expect(html).not.toContain('>5h<')
  expect(html).not.toContain('>wk<')
})

test('the Codex table degrades honestly when no pool snapshot exists', () => {
  const html = renderToStaticMarkup(
    <WelcomeScreen
      recents={[]}
      accounts={null}
      orchestratorActive={false}
      onOpenRecent={noop}
      onOpenFolder={noop}
    />,
  )
  expect(html).toContain('No Codex account data')
})

test("the 'session' variant shows a read-only cwd project (no picker) + the real Codex table", () => {
  // Chat.jsx:1272 renders the SAME WelcomeScreen when the session is empty. HC1:
  // the cwd is fixed at session-create, so Project is read-only context, not the
  // interactive picker, and no recents launcher appears.
  const html = renderToStaticMarkup(
    <WelcomeScreen
      variant="session"
      cwd="/Users/me/cat-code"
      accounts={pool([account({ id: 'main', alias: 'main', isDefault: true, usagePrimary: 15 })])}
      orchestratorActive={false}
    />,
  )
  // Same hero + Codex table body as the launcher (zero duplication).
  expect(html).toContain('Welcome back')
  expect(html).toContain('Codex')
  expect(html).toContain('main')
  expect(html).toContain('15%')
  // Project is the read-only session cwd, not the interactive picker.
  expect(html).toContain('/Users/me/cat-code')
  // No interactive project picker button and no recents launcher in-session.
  expect(html).not.toContain('<button')
  expect(html).not.toContain('Open a project')
})

test("the 'session' variant reflects orchestrator read-only and degrades a null pool + null cwd honestly", () => {
  const html = renderToStaticMarkup(
    <WelcomeScreen variant="session" cwd={null} accounts={null} orchestratorActive />,
  )
  expect(html).toContain('aria-readonly="true"')
  expect(html).toContain('>On<')
  // No wire cwd → an honest placeholder, never a fabricated path.
  expect(html).toContain('This workspace')
  expect(html).toContain('No Codex account data')
})

test('the orchestrator toggle is a read-only reflection of agent-mode', () => {
  const on = renderToStaticMarkup(
    <WelcomeScreen recents={[]} accounts={null} orchestratorActive onOpenRecent={noop} onOpenFolder={noop} />,
  )
  expect(on).toContain('aria-checked="true"')
  expect(on).toContain('aria-readonly="true"')
  expect(on).toContain('>On<')

  const off = renderToStaticMarkup(
    <WelcomeScreen recents={[]} accounts={null} orchestratorActive={false} onOpenRecent={noop} onOpenFolder={noop} />,
  )
  expect(off).toContain('aria-checked="false"')
  expect(off).toContain('>Off<')
})
