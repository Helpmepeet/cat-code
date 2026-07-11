import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  AccountsSnapshot,
  AgentModeSnapshot,
  AgentModeWorkerItem,
} from '../../shared/protocol.js'
import { OrchestratorPage } from './OrchestratorPage.js'

const noop = () => {}

function worker(over: Partial<AgentModeWorkerItem> = {}): AgentModeWorkerItem {
  return {
    agentId: 'w-1',
    handle: 'Turing',
    role: 'agent-mode-coding-worker',
    status: 'running',
    description: 'Build the roster',
    ...over,
  }
}

function snapshot(
  workers: AgentModeWorkerItem[],
  over: Partial<AgentModeSnapshot> = {},
): AgentModeSnapshot {
  return { active: true, objective: 'Ship it', phase: 'executing', workers, ...over }
}

const accounts: AccountsSnapshot = {
  accounts: [
    {
      id: 'a1',
      alias: 'primary',
      status: 'healthy',
      statusReason: null,
      availability: 'available',
      availabilityLabel: 'Ready',
      isDefault: true,
      hasVaultProfile: true,
      source: 'vault',
      usagePrimary: 10,
      usageWeekly: 20,
      usageLimitReached: false,
      usageResetAt: null,
      lastRefreshIso: null,
      lastError: null,
      planType: 'pro',
      switchable: false,
    },
  ],
  activeAccountId: 'a1',
  readyCount: 1,
  poolCount: 1,
  initialized: true,
}

test('renders the objective, phase, and Workers|Leases tabs with counts', () => {
  const html = renderToStaticMarkup(
    <OrchestratorPage
      snapshot={snapshot([worker()])}
      accountsSnapshot={accounts}
      onOpenTasks={noop}
      onFocusWorker={noop}
    />,
  )
  expect(html).toContain('Orchestrator')
  expect(html).toContain('Ship it') // objective
  expect(html).toContain('Executing') // phase label
  expect(html).toContain('Workers')
  expect(html).toContain('Leases')
})

test('the TasksButton renders (opening the existing tasks dialog) with worker badges', () => {
  const html = renderToStaticMarkup(
    <OrchestratorPage
      // active:false = the solo case, so a blocked worker owns the USER baton →
      // the amber attention badge fires (blocked-under-an-active-orchestrator is
      // neutral, D2 C2, and would NOT be amber).
      snapshot={snapshot(
        [
          worker({ status: 'running' }),
          worker({ agentId: 'w-2', handle: 'Bell', status: 'completed', handoffStatus: 'blocked' }),
        ],
        { active: false },
      )}
      accountsSnapshot={accounts}
      onOpenTasks={noop}
      onFocusWorker={noop}
    />,
  )
  expect(html).toContain('/tasks')
  // Amber human-attention badge present (the solo blocked worker owns the baton).
  expect(html).toContain('text-tone-warn')
})

test('worker rows are clickable drilldown buttons carrying the real handle', () => {
  const html = renderToStaticMarkup(
    <OrchestratorPage
      snapshot={snapshot([worker({ handle: 'Hopper', description: 'Wire the seam' })])}
      onOpenTasks={noop}
      onFocusWorker={noop}
    />,
  )
  expect(html).toContain('Hopper')
  expect(html).toContain('Wire the seam')
  expect(html).toContain('<button')
})

test('degrades to an honest empty state when no workers are on the wire', () => {
  const html = renderToStaticMarkup(
    <OrchestratorPage snapshot={snapshot([])} onOpenTasks={noop} onFocusWorker={noop} />,
  )
  expect(html).toContain('No workers yet')
})
