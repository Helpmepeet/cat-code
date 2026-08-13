import { readFileSync } from 'node:fs'
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  AgentModeSnapshot,
  AgentModeWorkerItem,
  LeaseOwnerRow,
  TaskSnapshotItem,
  TasksSnapshot,
} from '../../shared/protocol.js'
import {
  LeaseRosterPanel,
  TasksDialog,
  WorkerDetailPanel,
  WorkerRosterPanel,
} from './TasksDialog.js'
import { tasksDialogKeyAction } from './tasksState.js'

/**
 * This package has no DOM test harness (see AccountsPage.test.tsx's header) —
 * SSR string assertions + the pure `tasksState.ts` logic (covered directly in
 * tasksState.test.ts) is the established convention for this renderer.
 */

function item(over: Partial<TaskSnapshotItem> = {}): TaskSnapshotItem {
  return {
    id: 'b1',
    type: 'local_bash',
    status: 'running',
    label: 'npm test',
    startTime: 1,
    ...over,
  }
}

test('task keyboard selection stays represented by an accessible, scrollable active row', () => {
  const source = readFileSync(new URL('./TasksDialog.tsx', import.meta.url), 'utf8')
  expect(source).toContain('data-task-active={isSelected}')
  expect(source).toContain("querySelector('[data-task-active=\"true\"]')")
  expect(source).toContain("scrollIntoView({ block: 'nearest' })")
})

const noop = () => {}

test('renders nothing when closed', () => {
  const html = renderToStaticMarkup(
    <TasksDialog hasActiveSession={true} onClose={noop} open={false} snapshot={null} />,
  )
  expect(html).toBe('')
})

test('renders the plain empty state regardless of active-session scope', () => {
  const withSession = renderToStaticMarkup(
    <TasksDialog hasActiveSession={true} onClose={noop} open={true} snapshot={null} />,
  )
  expect(withSession).toContain('No background tasks')

  const withoutSession = renderToStaticMarkup(
    <TasksDialog hasActiveSession={false} onClose={noop} open={true} snapshot={null} />,
  )
  expect(withoutSession).toContain('No background tasks')
})

test('emits the modal focus container attributes', () => {
  const html = renderToStaticMarkup(
    <TasksDialog hasActiveSession={true} onClose={noop} open={true} snapshot={null} />,
  )
  expect(html).toContain('role="dialog"')
  expect(html).toContain('aria-modal="true"')
  expect(html).toContain('tabindex="-1"')
})

test('renders active and completed task rows with their labels and kind badge', () => {
  const snapshot: TasksSnapshot = {
    items: [
      item({ id: 'r1', type: 'remote_agent', status: 'running', label: 'Cloud PR review' }),
      item({ id: 'c1', type: 'dream', status: 'completed', label: 'Nightly cleanup' }),
    ],
  }
  const html = renderToStaticMarkup(
    <TasksDialog hasActiveSession={true} onClose={noop} open={true} snapshot={snapshot} />,
  )
  expect(html).toContain('Cloud PR review')
  expect(html).toContain('Nightly cleanup')
  expect(html).toContain('Remote')
  expect(html).toContain('Dream')
  expect(html).toContain('1 active')
  expect(html).toContain('1 completed')
})

test('excludes delegated agents from task rows and both task counts', () => {
  const snapshot: TasksSnapshot = {
    items: [
      item({ id: 'b1', status: 'running', label: 'bun test app/' }),
      item({ id: 'a1', type: 'local_agent', status: 'running', label: 'Inspect the retry helper' }),
      item({ id: 'a2', type: 'local_agent', status: 'completed', label: 'Review the settings panel' }),
    ],
  }
  const html = renderToStaticMarkup(
    <TasksDialog
      agentMode={agentModeSnapshotFixture({
        workers: [
          workerFixture(),
          workerFixture({ agentId: 'agent_b', handle: '@probe' }),
        ],
      })}
      hasActiveSession={true}
      onClose={noop}
      open={true}
      snapshot={snapshot}
    />,
  )
  const chip = (label: string) =>
    html.match(new RegExp(`${label}<span[^>]*>(\\d+)</span>`))?.[1]
  expect(html).toContain('1 active')
  expect(html).toContain('0 completed')
  expect(chip('Tasks')).toBe('1')
  expect(chip('Workers')).toBe('2')
  expect(html).not.toContain('Inspect the retry helper')
  expect(html).not.toContain('Review the settings panel')
})

test('an agents-only session points the empty Tasks tab at Workers', () => {
  const html = renderToStaticMarkup(
    <TasksDialog
      agentMode={agentModeSnapshotFixture({
        workers: [
          workerFixture(),
          workerFixture({ agentId: 'agent_b', handle: '@probe' }),
          workerFixture({ agentId: 'agent_c', handle: '@reviewer' }),
        ],
      })}
      hasActiveSession={true}
      onClose={noop}
      open={true}
      snapshot={{
        items: [
          item({ id: 'a1', type: 'local_agent', label: 'Inspect the retry helper' }),
          item({ id: 'a2', type: 'local_agent', label: 'Review the settings panel' }),
          item({ id: 'a3', type: 'local_agent', label: 'Check the failing test' }),
        ],
      }}
    />,
  )
  expect(html).toContain('0 active')
  expect(html).toContain('0 completed')
  expect(html).toContain('No background tasks')
  expect(html).toContain('3 workers are running, in Workers')
  expect(html).not.toContain('Run a background')
})

test('a blocked local_agent is omitted from Tasks because Workers owns delegated agents', () => {
  const snapshot: TasksSnapshot = {
    items: [
      item({
        id: 'a1',
        type: 'local_agent',
        status: 'running',
        label: 'Fix the flaky test',
        handoffStatus: 'blocked',
      }),
    ],
  }
  const html = renderToStaticMarkup(
    <TasksDialog hasActiveSession={true} onClose={noop} open={true} snapshot={snapshot} />,
  )
  expect(html).not.toContain('Fix the flaky test')
  expect(html).not.toContain('Waiting on the assistant')
  expect(html).not.toContain('Needs you')
})

test('P4-8b — the "K stop" footer hint appears ONLY when a stop handler is wired (no dead affordance)', () => {
  const snapshot: TasksSnapshot = {
    items: [item({ id: 'a1', type: 'local_agent', status: 'running', label: 'Wire the auth flow' })],
  }
  const withStop = renderToStaticMarkup(
    <TasksDialog
      hasActiveSession={true}
      onClose={noop}
      open={true}
      snapshot={snapshot}
      onStopTask={noop}
    />,
  )
  expect(withStop).toContain('stop')
  // ↑↓ select and esc close are always present; K stop only with a handler.
  const withoutStop = renderToStaticMarkup(
    <TasksDialog hasActiveSession={true} onClose={noop} open={true} snapshot={snapshot} />,
  )
  expect(withoutStop).toContain('select')
  expect(withoutStop).toContain('close')
  expect(withoutStop).not.toContain('stop')
})

/**
 * The dialog's keyboard contract. The component reads it through
 * `tasksDialogKeyAction`, which lives in `tasksState.ts` because a `.tsx` may
 * only export components (`lint:fast-refresh`); the dialog's own window listener
 * is installed in an effect, and this suite renders with `renderToStaticMarkup`,
 * which never runs effects.
 */
test('⌘K reaches the command palette instead of stopping the selected task', () => {
  // The bug: `event.key` is still 'k' while Meta is held, so opening the palette
  // from the dialog ALSO killed the first running task, with no confirmation.
  expect(tasksDialogKeyAction({ key: 'k', metaKey: true })).toBeNull()
  expect(tasksDialogKeyAction({ key: 'K', metaKey: true })).toBeNull()
  expect(tasksDialogKeyAction({ key: 'k', ctrlKey: true })).toBeNull()
  expect(tasksDialogKeyAction({ key: 'k', altKey: true })).toBeNull()
  // Chorded navigation/dismissal is the app's too (⌥↑/⌥↓ reorder workspaces).
  expect(tasksDialogKeyAction({ key: 'Escape', metaKey: true })).toBeNull()
  expect(tasksDialogKeyAction({ key: 'ArrowDown', altKey: true })).toBeNull()
  expect(tasksDialogKeyAction({ key: 'ArrowUp', ctrlKey: true })).toBeNull()
  // Unchorded keys still do exactly what the footer advertises.
  expect(tasksDialogKeyAction({ key: 'k' })).toBe('stop')
  expect(tasksDialogKeyAction({ key: 'K' })).toBe('stop')
  expect(tasksDialogKeyAction({ key: 'Escape' })).toBe('close')
  expect(tasksDialogKeyAction({ key: 'ArrowDown' })).toBe('next')
  expect(tasksDialogKeyAction({ key: 'ArrowUp' })).toBe('previous')
  expect(tasksDialogKeyAction({ key: 'x' })).toBeNull()
})

/* ── P4-32b — Workers + Leases tabs, worker drilldown, lease roster ────────────
 * The panels are rendered directly: this suite is SSR-only, so a tab click cannot
 * be simulated (see the component header). The tab BUTTONS are asserted on the
 * dialog itself.
 */

function agentModeSnapshotFixture(
  over: Partial<AgentModeSnapshot> = {},
): AgentModeSnapshot {
  return {
    active: true,
    objective: '',
    phase: 'executing',
    workers: [],
    ...over,
  }
}

function workerFixture(over: Partial<AgentModeWorkerItem> = {}): AgentModeWorkerItem {
  return {
    agentId: 'agent_a',
    handle: '@scout',
    role: 'coding-worker',
    status: 'running',
    description: 'audit the auth path',
    origin: 'current',
    ...over,
  }
}

function leaseOwnerFixture(over: Partial<LeaseOwnerRow> = {}): LeaseOwnerRow {
  return {
    leaseId: 'agent_a',
    ownerId: 'agent_a',
    ownerType: 'subagent',
    ownerLabel: 'audit the auth path',
    accountId: 'acct-1111',
    accountAlias: 'work-laptop',
    strategy: 'spread',
    state: 'active',
    createdAt: 0,
    updatedAt: 0,
    failoverCount: 0,
    selectionKind: 'initial',
    selectionReason: 'spread selected least crowded healthy account',
    ...over,
  }
}

test('the dialog offers Tasks, Workers and Accounts tabs with real counts', () => {
  const html = renderToStaticMarkup(
    <TasksDialog
      agentMode={agentModeSnapshotFixture({
        workers: [workerFixture(), workerFixture({ agentId: 'agent_b', handle: '@probe' })],
      })}
      hasActiveSession={true}
      leases={{ strategy: 'spread', owners: [leaseOwnerFixture()], accounts: [] }}
      onClose={noop}
      open={true}
      snapshot={{ items: [item()] }}
    />,
  )
  expect(html).toContain('Workers')
  // "Leases" is the engine's noun and the operator rejected it on screen.
  expect(html).toContain('Accounts')
  expect(html).not.toContain('Leases')
  // Counts read off their OWN chip, not anywhere in the document: a bare
  // `toContain('>2<')` was satisfied by the Workers chip and asserted nothing
  // about the Accounts count.
  const chip = (label: string) =>
    html.match(new RegExp(`${label}<span[^>]*>(\\d+)</span>`))?.[1]
  expect(chip('Tasks')).toBe('1')
  expect(chip('Workers')).toBe('2')
  expect(chip('Accounts')).toBe('1')
})

test('the Workers panel groups by role, shows normalized types, and keeps lifecycle compact', () => {
  const html = renderToStaticMarkup(
    <WorkerRosterPanel
      onSelect={noop}
      workers={[
        workerFixture(),
        workerFixture({
          agentId: 'agent_v',
          handle: '@judge',
          role: 'verification',
          status: 'completed',
        }),
      ]}
    />,
  )
  expect(html).toContain('Coding worker')
  expect(html).toContain('Verification')
  expect(html).toContain('scout')
  expect(html).toContain('judge')
  expect(html).toContain('audit the auth path')
  // Lifecycle is a pip plus accessible status, not a competing right-side word.
  expect(html).toContain('status Running')
  expect(html).toContain('1 done')
  expect(html).not.toContain('>running<')
  expect(html).not.toContain('>done<')
})

test('the Workers panel counts a blocked worker as the assistant’s, never as yours', () => {
  // D2 C2, now unconditional: the handoff is queued to the delegating
  // conversation whether or not this session runs the agent-mode persona, so
  // nothing here alarms the user.
  const blocked = workerFixture({ handoffStatus: 'blocked', blockReason: 'pick a schema' })
  const html = renderToStaticMarkup(
    <WorkerRosterPanel onSelect={noop} workers={[blocked]} />,
  )
  expect(html).toContain('1 on the assistant')
  expect(html).not.toContain('needs you')
})

test('the Workers panel distinguishes stopped and failed ownership', () => {
  const html = renderToStaticMarkup(
    <WorkerRosterPanel
      onSelect={noop}
      workers={[
        workerFixture({ agentId: 'stopped', status: 'killed', description: 'Stopped work' }),
        workerFixture({ agentId: 'failed', status: 'failed', description: 'Failed work' }),
      ]}
    />,
  )
  expect(html).toContain('1 on the assistant')
  expect(html).toContain('1 done')
  expect(html).toContain('status Stopped')
  expect(html).toContain('status Failed')
  expect(html).toContain('>Stopped<')
  expect(html).toContain('>Failed<')
  expect(html).not.toContain('status Attention')
  expect(html).not.toContain('>Attention<')
})

test('the Workers panel empty state names the real cause', () => {
  const html = renderToStaticMarkup(
    <WorkerRosterPanel onSelect={noop} workers={[]} />,
  )
  expect(html).toContain('No workers yet')
})

test('worker detail renders prompt, block reason and the Q2 result, and offers Stop', () => {
  const html = renderToStaticMarkup(
    <WorkerDetailPanel
      lease={leaseOwnerFixture({ failoverCount: 2, lastFailureReason: 'usage cap' })}
      nowMs={4 * 60_000}
      onBack={noop}
      onStopTask={noop}
      worker={workerFixture({
        handoffStatus: 'blocked',
        blockReason: 'pick a schema',
        outputSummary: 'ported the adapter',
      })}
    />,
  )
  expect(html).toContain('All workers')
  expect(html).toContain('Prompt')
  expect(html).toContain('audit the auth path')
  expect(html).toContain('Waiting on the assistant')
  expect(html).toContain('pick a schema')
  // Q2: the real conclusion appears HERE.
  expect(html).toContain('Result')
  expect(html).toContain('ported the adapter')
  // The surviving WMeta bits are real: the lease account, held time, failover.
  expect(html).toContain('acct work-laptop')
  expect(html).toContain('held 4m')
  expect(html).toContain('failed over ×2')
  expect(html).toContain('Stop')
})

test('worker detail hides Stop for a terminal worker and for a prior-session one', () => {
  const terminal = renderToStaticMarkup(
    <WorkerDetailPanel
      lease={null}
      onBack={noop}
      onStopTask={noop}
      worker={workerFixture({ status: 'completed' })}
    />,
  )
  expect(terminal).not.toContain('Stop')

  const prior = renderToStaticMarkup(
    <WorkerDetailPanel
      lease={null}
      onBack={noop}
      onStopTask={noop}
      worker={workerFixture({ origin: 'prior', resumable: true })}
    />,
  )
  expect(prior).not.toContain('Stop')
  expect(prior).toContain('resumable')
})

/* CC-32 follow-up — Dismiss is the finished-worker escape hatch the desktop
 * lacked. A blocked handoff gets no eviction deadline, so its row would otherwise
 * sit above the composer until the session process exits. */
test('CC-32 — worker detail offers Dismiss for a finished blocked worker, and Stop is absent there', () => {
  const html = renderToStaticMarkup(
    <WorkerDetailPanel
      lease={null}
      onBack={noop}
      onDismissTask={noop}
      onStopTask={noop}
      worker={workerFixture({
        status: 'completed',
        handoffStatus: 'blocked',
        blockReason: 'pick a schema',
      })}
    />,
  )
  expect(html).toContain('Dismiss')
  expect(html).not.toContain('Stop')
})

test('CC-32 — Dismiss is absent while the worker runs, for a prior-session worker, and with no active session', () => {
  const running = renderToStaticMarkup(
    <WorkerDetailPanel
      lease={null}
      onBack={noop}
      onDismissTask={noop}
      onStopTask={noop}
      worker={workerFixture({ status: 'running' })}
    />,
  )
  expect(running).not.toContain('Dismiss')
  expect(running).toContain('Stop')

  const prior = renderToStaticMarkup(
    <WorkerDetailPanel
      lease={null}
      onBack={noop}
      onDismissTask={noop}
      worker={workerFixture({ status: 'completed', origin: 'prior' })}
    />,
  )
  expect(prior).not.toContain('Dismiss')

  // No active session → no verb to send, so no dead affordance.
  const noSession = renderToStaticMarkup(
    <WorkerDetailPanel
      lease={null}
      onBack={noop}
      worker={workerFixture({ status: 'completed' })}
    />,
  )
  expect(noSession).not.toContain('Dismiss')
})

test('Workers rows and detail headers omit null and legacy-id names without inventing Subagent', () => {
  const worker = workerFixture({
    agentId: 'internal-agent-id',
    handle: 'internal-agent-id',
    role: 'Explore',
    description: 'Inspect the repository',
  })
  const roster = renderToStaticMarkup(
    <WorkerRosterPanel
      onSelect={noop}
      workers={[worker, { ...worker, agentId: 'unnamed', handle: null }]}
    />,
  )
  expect(roster).not.toContain('internal-agent-id')
  expect(roster).not.toContain('>Unnamed worker<')
  expect(roster).not.toContain('Subagent')
  expect(roster).toContain('Inspect the repository')
  expect(roster).toContain('Explore')

  const detail = renderToStaticMarkup(
    <WorkerDetailPanel
      lease={null}
      onBack={noop}
      worker={worker}
    />,
  )
  expect(detail).not.toContain('internal-agent-id')
  expect(detail).not.toContain('Subagent')
  expect(detail).toContain('Explore')
})

test('Workers compact rows normalize general-purpose and keep Resumable accessible but not visible', () => {
  const worker = workerFixture({
    agentId: 'legacy-resumable-id',
    handle: 'legacy-resumable-id',
    role: 'general-purpose',
    status: 'completed',
    origin: 'prior',
    resumable: true,
    description: 'Resume the investigation',
  })
  const roster = renderToStaticMarkup(
    <WorkerRosterPanel onSelect={noop} workers={[worker]} />,
  )
  expect(roster).toContain('General-purpose')
  expect(roster).toContain('status Resumable')
  expect(roster).not.toContain('>Resumable<')
  expect(roster).not.toContain('legacy-resumable-id')
  const compactRow = roster.match(
    /<button aria-label="Resume the investigation, type General-purpose, status Resumable"[\s\S]*?<\/button>/,
  )?.[0]
  expect(compactRow).toBeDefined()
  // The row owns one lifecycle pip. AgentTypeLabel is text-only and must not
  // manufacture a second status-like ring beside it.
  expect(compactRow?.match(/rounded-full/g)).toHaveLength(1)
  expect(compactRow).not.toContain('border-[1.4px]')

  const detail = renderToStaticMarkup(
    <WorkerDetailPanel
      lease={null}
      onBack={noop}
      worker={worker}
    />,
  )
  expect(detail).toContain('Resumable')
})

test('worker detail fabricates no WMeta field when there is no lease (waiver 7)', () => {
  const html = renderToStaticMarkup(
    <WorkerDetailPanel
      lease={null}
      onBack={noop}
      worker={workerFixture()}
    />,
  )
  // Model / elapsed / tool count / traffic / cost are WAIVED, not mocked: no
  // placeholder, no zero, no dash.
  expect(html).not.toContain('tools')
  expect(html).not.toContain('acct')
  expect(html).not.toContain('held')
  expect(html).not.toContain('$')
})

test('worker detail offers no focus/open-thread affordance (D1 waives WorkerFocusView)', () => {
  const html = renderToStaticMarkup(
    <WorkerDetailPanel
      lease={null}
      onBack={noop}
      onStopTask={noop}
      worker={workerFixture()}
    />,
  )
  expect(html).not.toContain('Open thread')
  expect(html).not.toContain('Viewing')
  // No composer: the user only ever talks to the orchestrator.
  expect(html).not.toContain('<textarea')
  expect(html).not.toContain('<input')
})

test('the Accounts panel groups agents under the account each one holds', () => {
  const html = renderToStaticMarkup(
    <LeaseRosterPanel
      nowMs={90 * 60_000}
      snapshot={{
        strategy: 'spread',
        owners: [
          leaseOwnerFixture({
            leaseId: 'main',
            ownerId: 'main-thread',
            ownerType: 'main',
            ownerLabel: 'Main thread',
            strategy: 'follow-main',
            selectionReason: 'main lease pinned to pool activeIndex',
          }),
          leaseOwnerFixture({
            ownerId: 'agent_a',
            accountId: 'acct-2222',
            accountAlias: 'aurora',
            failoverCount: 1,
            selectionKind: 'failover',
            selectionReason: 'failover from acct-1111: Codex account acct-1111 is capped',
            lastFailureReason: 'Codex account acct-1111 is capped',
          }),
        ],
        accounts: [],
      }}
      workers={[
        {
          agentId: 'agent_a',
          handle: 'Hopper',
          role: 'general-purpose',
          status: 'running',
          description: 'audit the auth path',
        },
      ]}
    />,
  )
  expect(html).toContain('Strategy')
  expect(html).toContain('spread')
  // Both accounts head their own group, each with its own count.
  expect(html).toContain('work-laptop')
  expect(html).toContain('aurora')
  // `'1 agents'.includes('1 agent')` is true, so the closing bracket is what
  // actually pins the singular branch.
  expect(html).toContain('1 agent<')
  // The worker's real name leads its row; its task text follows.
  expect(html).toContain('Hopper')
  expect(html).toContain('audit the auth path')
  expect(html).toContain('Main thread')
  expect(html).toContain('1h 30m')
  expect(html).toContain('moved here from another account')
  // The engine's own prose and ids stay out of the body text.
  expect(html).not.toContain('main lease pinned to pool activeIndex')
  expect(html).not.toContain('failover from')
  expect(html).not.toContain('Owners')
  expect(html).not.toContain('Accounts in use')
  // The failover/rotation EVENT strip is CUT: the engine exposes no event history.
  expect(html).not.toContain('rotation')
})

test('a spread session that landed on one account says so, and otherwise says nothing', () => {
  const onOneAccount = (count: number) =>
    renderToStaticMarkup(
      <LeaseRosterPanel
        nowMs={0}
        snapshot={{
          strategy: 'spread',
          owners: Array.from({ length: count }, (_, index) =>
            leaseOwnerFixture({ ownerId: `agent_${index}`, leaseId: `agent_${index}` }),
          ),
          accounts: [],
        }}
      />,
    )
  expect(onOneAccount(3)).toContain('All 3 agents landed on one account.')
  expect(onOneAccount(1)).not.toContain('landed on one account')
})

test('an agent that could not get an account is stranded above the working ones', () => {
  const html = renderToStaticMarkup(
    <LeaseRosterPanel
      nowMs={0}
      snapshot={{
        strategy: 'spread',
        owners: [
          leaseOwnerFixture({ ownerId: 'agent_ok', leaseId: 'agent_ok' }),
          leaseOwnerFixture({
            ownerId: 'agent_bad',
            leaseId: 'agent_bad',
            state: 'failed',
            failoverCount: 2,
            lastFailureReason: 'account is capped',
          }),
        ],
        accounts: [],
      }}
    />,
  )
  expect(html).toContain('No account')
  expect(html).toContain('every account was capped or unavailable')
  expect(html.indexOf('No account')).toBeLessThan(html.indexOf('work-laptop'))
})

test('the Accounts panel empty state tells the user what makes an account appear', () => {
  const html = renderToStaticMarkup(<LeaseRosterPanel snapshot={null} />)
  expect(html).toContain('No accounts in use')
  expect(html).toContain('Agents take one when they run')
  // The default strategy is stated rather than left blank.
  expect(html).toContain('spread')
})

test('no user-visible string on the Accounts panel says "lease"', () => {
  const html = renderToStaticMarkup(
    <LeaseRosterPanel
      snapshot={{ strategy: 'spread', owners: [leaseOwnerFixture()], accounts: [] }}
    />,
  )
  // Class names are not user-visible text; the rendered text nodes are.
  const text = html.replace(/<[^>]*>/g, ' ')
  expect(text.toLowerCase()).not.toContain('lease')
})

test('the hover detail is a text surface too, so no account id survives in it', () => {
  const rawId = 'ca889574-256c-4f04-8d5f-f80004f1a8e1'
  const html = renderToStaticMarkup(
    <LeaseRosterPanel
      nowMs={0}
      snapshot={{
        strategy: 'spread',
        owners: [
          leaseOwnerFixture({
            failoverCount: 1,
            selectionKind: 'failover',
            selectionReason: `failover from ${rawId}: Codex account ${rawId} is capped`,
            lastFailureReason: `Codex account ${rawId} is capped`,
          }),
        ],
        accounts: [],
      }}
    />,
  )
  // Stripping tags would drop attributes by construction, so assert on the whole
  // document: CLAUDE.md §7 lists `title` alongside JSX text.
  expect(html).not.toContain(rawId)
  expect(html).toContain('title="Codex account is capped"')
})

test('the rail brackets the group heading together with its rows', () => {
  // The single-account state is the one the operator rejected: with the rail
  // starting below the heading, a lone group read as a plain list under a label.
  // SSR markup is the only evidence available here, so the nesting is asserted.
  const html = renderToStaticMarkup(
    <LeaseRosterPanel
      nowMs={0}
      snapshot={{ strategy: 'spread', owners: [leaseOwnerFixture()], accounts: [] }}
    />,
  )
  const rail = html.match(/<div class="border-l [^"]*">([\s\S]*?)$/)?.[1] ?? ''
  expect(rail).toContain('work-laptop')
  expect(rail).toContain('audit the auth path')
  // The count sits beside the account name, not pushed to the far edge. Asserted
  // as adjacency rather than "no ml-auto anywhere": the concentration note above
  // legitimately uses ml-auto, so the looser check would false-fail later.
  expect(html).toMatch(/work-laptop<\/span><span[^>]*>1 agent</)
})

test('no P4-32b surface renders an em dash (operator rule)', () => {
  const panels = [
    renderToStaticMarkup(
      <WorkerRosterPanel
        onSelect={noop}
        workers={[workerFixture()]}
      />,
    ),
    renderToStaticMarkup(
      <WorkerDetailPanel
        lease={leaseOwnerFixture()}
        nowMs={0}
        onBack={noop}
        onStopTask={noop}
        worker={workerFixture({ handoffStatus: 'blocked', blockReason: 'pick a schema' })}
      />,
    ),
    renderToStaticMarkup(
      <LeaseRosterPanel
        snapshot={{ strategy: 'spread', owners: [leaseOwnerFixture()], accounts: [] }}
      />,
    ),
    renderToStaticMarkup(<LeaseRosterPanel snapshot={null} />),
  ]
  for (const html of panels) {
    expect(html).not.toContain('—')
  }
})
