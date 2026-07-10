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
  expect(html).toContain('ready')
  expect(html).toContain('main')
  expect(html).toContain('backup')
  expect(html).toContain('capped')
  expect(html).toContain('20%')
  expect(html).toContain('100%')
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
