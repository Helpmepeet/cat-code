import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { OrchestratorReflect, RecentItem, WelcomeScreen } from './WelcomeScreen.js'
import type { RecentWorkspace } from './sessionsCatalogState.js'
import type { AccountsSnapshot, AccountStatus } from '../../shared/protocol.js'

function recent(over: Partial<RecentWorkspace> & { cwd: string }): RecentWorkspace {
  return {
    name: over.cwd.split('/').pop() ?? over.cwd,
    appSessionId: null,
    live: false,
    historySessionId: null,
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
    anthropicAccounts: [],
    anthropicActiveAccountId: null,
    anthropicReadyCount: 0,
    anthropicPoolCount: 0,
    anthropicInitialized: true,
    anthropicRouteAvailable: false,
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
  expect(html).toContain('<img')
  expect(html).toContain('alt=""')
  // The picker trigger reflects the most-recent project name.
  expect(html).toContain('cat-code')
})

test('uses a randomized packaged cat image rather than embedding the hero as SVG', () => {
  const source = readFileSync(new URL('./WelcomeScreen.tsx', import.meta.url), 'utf8')

  expect(source).toContain("import sleepingCat from './assets/sleeping-cat.png'")
  expect(source).toContain('const welcomeCats = [')
  expect(source).toContain('Math.floor(Math.random() * welcomeCats.length)')
  expect(source).toContain('src={welcomeCat}')
  expect(source).not.toContain('function NeonCat()')
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
  expect(html).not.toContain('New worktree')
  expect(html).not.toContain('Branch')
  expect(html).not.toContain('feat/cat-launcher')
  // With no recents the trigger invites a first project instead of a mock path.
  expect(html).toContain('Open a project')
})

test('P4-59 keeps Open folder actionable without advertising an unbound shortcut', () => {
  // The package has no DOM harness, and the menu is closed during SSR. Pin the
  // menu item's handler wiring in its exact source region, following App.test.tsx.
  const source = readFileSync(new URL('./WelcomeScreen.tsx', import.meta.url), 'utf8')
  const pickerStart = source.indexOf('function ProjectPicker({')
  const pickerEnd = source.indexOf('\n/**\n * One recent-project row.', pickerStart)
  const picker = source.slice(pickerStart, pickerEnd).replace(/\s+/g, ' ')

  expect(pickerStart).toBeGreaterThan(-1)
  expect(pickerEnd).toBeGreaterThan(pickerStart)
  expect(picker).toContain('role="menuitem"')
  expect(picker).toContain('Open folder…')
  expect(picker).toContain('onClick={() => { close() onOpenFolder() }}')
  expect(picker).not.toContain('⌘O')
})

test('Codex usage meters follow the selected accent rather than a hard-coded color', () => {
  const source = readFileSync(new URL('./WelcomeScreen.tsx', import.meta.url), 'utf8')

  expect(source).toContain('from-accent-soft to-accent')
  expect(source).toContain("p >= 100 ? 'text-accent' : 'text-accent-soft'")
  // Asserted as the HEX rather than a whole class. This guard exists for the
  // historical regression of a hardcoded pink, and pinning the exact class
  // string let the appearance pass rewrite it into a form that no longer
  // matched the thing being guarded against.
  expect(source).not.toContain('#f9a8d4')
  expect(source).not.toContain('#ec4899')
})

test('P4-55 renders a truthful retry in place of the false empty roster', () => {
  const html = renderToStaticMarkup(
    <WelcomeScreen
      recents={[]}
      accounts={null}
      orchestratorActive={false}
      onOpenRecent={noop}
      onOpenFolder={noop}
      rosterFailure={{ retrying: false, onRetry: noop }}
    />,
  )

  expect(html).toContain('Recent projects could not load.')
  expect(html).toContain('>Retry</button>')
  expect(html).not.toContain('Open a project')
  expect(html).not.toContain('No recent projects yet.')
  expect(html).not.toContain('aria-live')
  expect(html).not.toContain('—')
})

test('P4-55 keeps the failure visible and disables duplicate retries while reading', () => {
  const html = renderToStaticMarkup(
    <WelcomeScreen
      recents={[]}
      accounts={null}
      orchestratorActive={false}
      onOpenRecent={noop}
      onOpenFolder={noop}
      rosterFailure={{ retrying: true, onRetry: noop }}
    />,
  )

  expect(html).toContain('Recent projects could not load.')
  expect(html).toContain('disabled=""')
  expect(html).toContain('aria-busy="true"')
})

const FIRST_RUN_ORDER = 'Open a project to start. Sign in once it opens.'

test('P4-48 — with no account anywhere, the launcher states the order of the first two steps', () => {
  // The defect: the sign-in card cannot render before a project is open, so a
  // genuine first launch offered no clue that opening one comes first.
  const html = renderToStaticMarkup(
    <WelcomeScreen
      recents={[]}
      accounts={pool([])}
      orchestratorActive={false}
      onOpenRecent={noop}
      onOpenFolder={noop}
    />,
  )
  expect(html).toContain(FIRST_RUN_ORDER)
  // Copy only: the ruling authorised no sign-in control on this screen.
  expect(html).not.toContain('Open browser to sign in')
  // User-visible text rule (CLAUDE.md §7): no em dash on any read surface.
  expect(html).not.toContain('—')
})

test('P4-48 — an account already in the pool silences the line', () => {
  const html = renderToStaticMarkup(
    <WelcomeScreen
      recents={[recent({ cwd: '/w/cat-code', appSessionId: 'a' })]}
      accounts={pool([account({ id: 'main', isDefault: true })])}
      orchestratorActive={false}
      onOpenRecent={noop}
      onOpenFolder={noop}
    />,
  )
  expect(html).not.toContain(FIRST_RUN_ORDER)
})

test('P4-48 — a configured Anthropic route silences the line even with an empty pool', () => {
  // `shouldShowFirstRunOAuth` is the gate this copy mirrors: an API key, Bedrock,
  // Vertex or Foundry route means no sign-in card ever appears, so promising one
  // would be false.
  const html = renderToStaticMarkup(
    <WelcomeScreen
      recents={[]}
      accounts={{ ...pool([]), anthropicRouteAvailable: true }}
      orchestratorActive={false}
      onOpenRecent={noop}
      onOpenFolder={noop}
    />,
  )
  expect(html).not.toContain(FIRST_RUN_ORDER)
})

test('P4-48 — an unreported pool claims nothing', () => {
  // Null is "not known yet", not "no account". Claiming a sign-in step here
  // would flash a false instruction at a signed-in user during boot.
  const html = renderToStaticMarkup(
    <WelcomeScreen
      recents={[]}
      accounts={null}
      orchestratorActive={false}
      onOpenRecent={noop}
      onOpenFolder={noop}
    />,
  )
  expect(html).not.toContain(FIRST_RUN_ORDER)
})

test("P4-48 — the 'session' variant never carries the line", () => {
  // A session exists, so the real sign-in card is reachable and the launcher's
  // ordering advice is neither true nor needed.
  const html = renderToStaticMarkup(
    <WelcomeScreen variant="session" cwd="/w" branch={null} accounts={pool([])} orchestratorActive={false} />,
  )
  expect(html).not.toContain(FIRST_RUN_ORDER)
})

test('the Codex table renders real pool rows (alias, capped badge, usage %)', () => {
  const now = Math.floor(Date.now() / 1000)
  const html = renderToStaticMarkup(
    <WelcomeScreen
      recents={[]}
      accounts={pool([
        account({
          id: 'main',
          alias: 'main',
          isDefault: true,
          usagePrimary: 20,
          usageWeekly: 40,
          usageResetAt: now + 3 * 3600,
          usageWeeklyResetAt: now + 4 * 3600,
        }),
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
  expect(html).toContain('aria-label="5-hour reset: 3h"')
  expect(html).toContain('aria-label="Weekly reset: 4h"')
  // Flat accent-gradient bars, not tone-coded green/amber/red.
  expect(html).toContain('from-accent-soft to-accent')
  expect(html).toContain('aria-label="5-hour usage: 20%"')
  expect(html).toContain('aria-label="Weekly usage: 40%"')
  expect(html).toContain('role="progressbar"')
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
      branch="feature/login"
      accounts={pool([account({ id: 'main', alias: 'main', isDefault: true, usagePrimary: 15 })])}
      orchestratorActive={false}
    />,
  )
  // Same hero + Codex table body as the launcher (zero duplication).
  expect(html).toContain('Welcome back')
  expect(html).toContain('Codex')
  expect(html).toContain('main')
  expect(html).toContain('15%')
  // Project is the read-only session workspace, not the interactive picker: the
  // NAME is what renders (a full cwd truncates mid-path in this column), with
  // the whole path one hover away.
  expect(html).toContain('title="/Users/me/cat-code"')
  expect(html).toContain('>cat-code<')
  // The real git branch is shown read-only in its own meta column.
  expect(html).toContain('Branch')
  expect(html).toContain('feature/login')
  // No interactive project picker button and no recents launcher in-session.
  expect(html).not.toContain('<button')
  expect(html).not.toContain('Open a project')
})

test("'Start in' reports the one thing about a session's start that varies", () => {
  // The prototype's chooser is cut with its worktree option, so a constant label
  // was all this column ever said. Sandboxing is a real per-session fact already
  // on `diagnostics.snapshot`.
  const plain = renderToStaticMarkup(
    <WelcomeScreen variant="session" cwd="/w" branch={null} accounts={null} orchestratorActive={false} />,
  )
  expect(plain).toContain('Locally')
  expect(plain).not.toContain('Sandboxed')

  const sandboxed = renderToStaticMarkup(
    <WelcomeScreen
      variant="session"
      cwd="/w"
      branch={null}
      sandboxed
      accounts={null}
      orchestratorActive={false}
    />,
  )
  expect(sandboxed).toContain('Sandboxed')

  // The launcher has no session to ask, so it keeps the plain default.
  const launcher = renderToStaticMarkup(
    <WelcomeScreen recents={[]} accounts={null} orchestratorActive={false} onOpenRecent={noop} onOpenFolder={noop} />,
  )
  expect(launcher).toContain('Locally')
  expect(launcher).not.toContain('Sandboxed')
})

test("the 'session' variant reflects orchestrator read-only and degrades a null pool + null cwd honestly", () => {
  const html = renderToStaticMarkup(
    <WelcomeScreen variant="session" cwd={null} branch={null} accounts={null} orchestratorActive />,
  )
  expect(html).toContain('aria-readonly="true"')
  expect(html).toContain('>On<')
  // No wire cwd → an honest placeholder, never a fabricated path.
  expect(html).toContain('This workspace')
  expect(html).toContain('No Codex account data')
})

test('P4-40 — a project whose sessions all came from the terminal is a live row', () => {
  // It has no app id (nothing in it was ever a desktop session) but it does have
  // an engine id, which is the identity the history route opens by. Before P4-40
  // this rendered as a greyed, unclickable div.
  const html = renderToStaticMarkup(
    <RecentItem recent={recent({ cwd: '/w/two', historySessionId: 'ec' })} onOpen={noop} />,
  )
  expect(html).toContain('<button')
  expect(html).toContain('hover:bg-white/[0.045]')
  expect(html).not.toContain('opacity-60')
})

test('P4-40 — a project whose folder is gone stays unopenable, and says what to do', () => {
  const html = renderToStaticMarkup(
    <RecentItem recent={recent({ cwd: '/w/gone' })} onOpen={noop} />,
  )
  expect(html).not.toContain('<button')
  expect(html).toContain('opacity-60')
  expect(html).toContain('This folder is missing from disk.')
  // The stale claim this session removed: open-from-history shipped, so the
  // desktop CAN restore a terminal-created project.
  expect(html).not.toContain('The desktop cannot restore it yet')
  // User-visible text rule (CLAUDE.md §7): no em dash on any read surface.
  expect(html).not.toContain('—')
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

test("P4-8b — the 'session' variant Orchestrator is INTERACTIVE when a toggle callback is present", () => {
  // With `onToggleOrchestrator` (the in-session case, App wires it per panel) the
  // reflect becomes a real <button role="switch"> — no longer aria-readonly.
  const html = renderToStaticMarkup(
    <WelcomeScreen
      variant="session"
      cwd="/w"
      branch={null}
      accounts={null}
      orchestratorActive={false}
      onToggleOrchestrator={() => {}}
    />,
  )
  expect(html).toContain('role="switch"')
  expect(html).toContain('aria-checked="false"')
  expect(html).toContain('<button')
  // Interactive → NOT the read-only reflect.
  expect(html).not.toContain('aria-readonly="true"')
})

test("P4-8b — the 'session' variant stays READ-ONLY when no toggle callback is present", () => {
  // No callback (defensive / launcher-parity) → the honest read-only span, no button.
  const html = renderToStaticMarkup(
    <WelcomeScreen variant="session" cwd="/w" branch={null} accounts={null} orchestratorActive />,
  )
  expect(html).toContain('aria-readonly="true"')
  expect(html).not.toContain('<button')
})

test('P4-8b — clicking the interactive Orchestrator calls the callback with the NEGATED active', () => {
  // This package has no DOM click harness (AccountsPage.test.tsx convention), so
  // the handler is exercised by invoking the hook-free component directly and
  // reading its onClick off the returned element — the exact code path a click runs.
  const calls: boolean[] = []
  const onEl = OrchestratorReflect({ active: true, onToggle: next => calls.push(next) })
  expect(onEl.props.role).toBe('switch')
  expect(onEl.props['aria-checked']).toBe(true)
  onEl.props.onClick()
  expect(calls).toEqual([false]) // true → toggles OFF

  const offEl = OrchestratorReflect({ active: false, onToggle: next => calls.push(next) })
  offEl.props.onClick()
  expect(calls).toEqual([false, true]) // false → toggles ON
})

test('P4-8b — without a callback OrchestratorReflect is a non-interactive read-only span', () => {
  const el = OrchestratorReflect({ active: true })
  expect(el.props['aria-readonly']).toBe('true')
  expect(el.props.onClick).toBeUndefined()
})
