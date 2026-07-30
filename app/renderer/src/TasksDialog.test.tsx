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

const noop = () => {}

test('renders nothing when closed', () => {
  const html = renderToStaticMarkup(
    <TasksDialog hasActiveSession={true} onClose={noop} open={false} snapshot={null} />,
  )
  expect(html).toBe('')
})

test('renders the empty state, branched on active-session scope', () => {
  const withSession = renderToStaticMarkup(
    <TasksDialog hasActiveSession={true} onClose={noop} open={true} snapshot={null} />,
  )
  expect(withSession).toContain('No tasks in this session')

  const withoutSession = renderToStaticMarkup(
    <TasksDialog hasActiveSession={false} onClose={noop} open={true} snapshot={null} />,
  )
  expect(withoutSession).toContain('No background tasks')
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

test('a needs-input local_agent row surfaces the real handoffStatus-derived state label', () => {
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
  expect(html).toContain('Fix the flaky test')
  expect(html).toContain('Needs you')
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
    selectionReason: 'spread selected least crowded healthy account',
    ...over,
  }
}

test('the dialog offers Tasks, Workers and Leases tabs with real counts', () => {
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
  expect(html).toContain('Leases')
  // Counts: 1 task, 2 workers, 1 active lease.
  expect(html).toContain('>2<')
})

test('the Workers panel groups by role and shows the compressed state word', () => {
  const html = renderToStaticMarkup(
    <WorkerRosterPanel
      onSelect={noop}
      orchestratorActive={true}
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
  // Compressed list vocabulary, not the full "Completed" chip label.
  expect(html).toContain('running')
  expect(html).toContain('done')
})

test('the Workers panel counts a blocked worker as the assistant’s, never as yours', () => {
  // D2 C2: an active orchestrator owns the handoff, so nothing alarms the user.
  const blocked = workerFixture({ handoffStatus: 'blocked', blockReason: 'pick a schema' })
  const withOrchestrator = renderToStaticMarkup(
    <WorkerRosterPanel onSelect={noop} orchestratorActive={true} workers={[blocked]} />,
  )
  expect(withOrchestrator).toContain('1 on the assistant')
  expect(withOrchestrator).not.toContain('needs you')

  const solo = renderToStaticMarkup(
    <WorkerRosterPanel onSelect={noop} orchestratorActive={false} workers={[blocked]} />,
  )
  expect(solo).toContain('1 needs you')
})

test('the Workers panel empty state names the real cause', () => {
  const html = renderToStaticMarkup(
    <WorkerRosterPanel onSelect={noop} orchestratorActive={true} workers={[]} />,
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
      orchestratorActive={true}
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
      orchestratorActive={true}
      worker={workerFixture({ status: 'completed' })}
    />,
  )
  expect(terminal).not.toContain('Stop')

  const prior = renderToStaticMarkup(
    <WorkerDetailPanel
      lease={null}
      onBack={noop}
      onStopTask={noop}
      orchestratorActive={true}
      worker={workerFixture({ origin: 'prior', resumable: true })}
    />,
  )
  expect(prior).not.toContain('Stop')
  expect(prior).toContain('resumable')
})

test('worker detail fabricates no WMeta field when there is no lease (waiver 7)', () => {
  const html = renderToStaticMarkup(
    <WorkerDetailPanel
      lease={null}
      onBack={noop}
      orchestratorActive={true}
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
      orchestratorActive={true}
      worker={workerFixture()}
    />,
  )
  expect(html).not.toContain('Open thread')
  expect(html).not.toContain('Viewing')
  // No composer: the user only ever talks to the orchestrator.
  expect(html).not.toContain('<textarea')
  expect(html).not.toContain('<input')
})

test('the Leases panel renders strategy, the account rollup and owner rows', () => {
  const html = renderToStaticMarkup(
    <LeaseRosterPanel
      nowMs={90 * 60_000}
      snapshot={{
        strategy: 'follow-main',
        owners: [
          leaseOwnerFixture({
            leaseId: 'main',
            ownerId: 'main-thread',
            ownerType: 'main',
            ownerLabel: 'Main thread',
            strategy: 'follow-main',
            selectionReason: 'main lease pinned to pool activeIndex',
          }),
          leaseOwnerFixture({ failoverCount: 1, lastFailureReason: 'usage cap' }),
        ],
        accounts: [
          {
            accountId: 'acct-1111',
            accountAlias: 'work-laptop',
            leaseCount: 2,
            holders: ['Main thread', 'audit the auth path'],
          },
        ],
      }}
    />,
  )
  expect(html).toContain('follow-main')
  expect(html).toContain('Accounts in use')
  expect(html).toContain('work-laptop')
  expect(html).toContain('2 leases')
  expect(html).toContain('Owners')
  expect(html).toContain('Main thread')
  expect(html).toContain('main lease pinned to pool activeIndex')
  expect(html).toContain('subagent')
  expect(html).toContain('failed over ×1')
  expect(html).toContain('1h 30m')
  // The failover/rotation EVENT strip is CUT: the engine exposes no event history.
  expect(html).not.toContain('rotation')
  expect(html).not.toContain('moved')
})

test('the Leases panel empty state tells the user what makes a lease appear', () => {
  const html = renderToStaticMarkup(<LeaseRosterPanel snapshot={null} />)
  expect(html).toContain('No active leases')
  expect(html).toContain('Agents lease an account when they run')
  // The default strategy is stated rather than left blank.
  expect(html).toContain('spread')
})

test('no P4-32b surface renders an em dash (operator rule)', () => {
  const panels = [
    renderToStaticMarkup(
      <WorkerRosterPanel
        onSelect={noop}
        orchestratorActive={true}
        workers={[workerFixture()]}
      />,
    ),
    renderToStaticMarkup(
      <WorkerDetailPanel
        lease={leaseOwnerFixture()}
        nowMs={0}
        onBack={noop}
        onStopTask={noop}
        orchestratorActive={true}
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
