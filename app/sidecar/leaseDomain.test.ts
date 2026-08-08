/**
 * P4-32b — the Codex lease read seam (L1, `decisions/ORCHESTRATOR-IN-SESSION.md`
 * §7, ruled §10).
 *
 * Two things are load-bearing here and both get a live-path test rather than a
 * shape test:
 *
 *  1. **The join key.** `LeaseOwnerRow.ownerId` must equal the roster's
 *     `AgentModeWorkerItem.agentId`, or the worker detail renders someone else's
 *     account. So the round-trip below puts a lease in the ENGINE's own map under
 *     the id `AgentTool` registers, looks it up through the engine's own
 *     `getCodexLeaseForOwner`, builds the roster with the REAL
 *     `agentModeSnapshot`, and asserts the two ids meet.
 *  2. **Redaction.** The projection must be `secretGuard`-clean even when the pool
 *     holds tokens.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createTaskStateBase } from '../../src/Task.js'
import {
  getCodexLeaseForOwner,
  getCodexLeaseSnapshot,
  resetCodexLeaseManagerForTest,
  seedCodexLeaseForTest,
  type CodexLease,
} from '../../src/services/api/codexAccountLeaseManager.js'
import type { LocalAgentTaskState } from '../../src/tasks/LocalAgentTask/LocalAgentTask.js'
import type { TaskState } from '../../src/tasks/types.js'
import type { AppStateStore } from '../../src/state/AppStateStore.js'
import type { LeaseSnapshotFrame } from '../shared/protocol.js'
import { scanForSecrets } from '../shared/secretGuard.js'
import { agentModeSnapshot } from './agentModeDomain.js'
import {
  createSidecarLeaseDomain,
  leaseSnapshot,
  type LeaseReader,
} from './leaseDomain.js'

afterEach(() => {
  resetCodexLeaseManagerForTest()
})

function lease(over: Partial<CodexLease> = {}): CodexLease {
  return {
    leaseId: 'agent_abc',
    ownerId: 'agent_abc',
    ownerType: 'subagent',
    ownerLabel: 'audit the auth path',
    accountId: 'acct-1111',
    strategy: 'spread',
    state: 'active',
    createdAt: 1_000,
    updatedAt: 1_000,
    failoverCount: 0,
    selectionKind: 'initial',
    selectionReason: 'spread selected least crowded healthy account',
    ...over,
  }
}

/** A LeaseReader fake — the engine-facing seam, so the projection is pure. */
function fakeReader(
  options: {
    mainLease?: CodexLease | null
    leases?: CodexLease[]
    strategy?: 'spread' | 'follow-main'
    accounts?: Array<{ accountId: string; leaseCount: number; holders: string[] }>
    aliases?: Record<string, string | null>
  } = {},
): LeaseReader {
  const byOwner = new Map((options.leases ?? []).map(l => [l.ownerId, l]))
  return {
    snapshot: () => ({
      mainLease: options.mainLease ?? null,
      strategy: options.strategy ?? 'spread',
      accounts: options.accounts ?? [],
    }),
    leaseForOwner: ownerId => byOwner.get(ownerId),
    accountAliases: () => new Map(Object.entries(options.aliases ?? {})),
  }
}

function localAgentTask(over: Partial<LocalAgentTaskState> = {}): TaskState {
  const agentId = over.agentId ?? over.id ?? 'agent_abc'
  return {
    // A local_agent task's id IS its agentId — the identity the join relies on.
    ...createTaskStateBase(agentId, 'local_agent', 'audit the auth path'),
    type: 'local_agent',
    status: 'running',
    agentId,
    agentType: 'coding-worker',
    prompt: 'audit',
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: false,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
    ...over,
  } as TaskState
}

describe('lease projection', () => {
  test('the account a lease moved OFF is resolved to its alias here, or omitted', () => {
    // Only this side can do it: `accountAliases()` reads the WHOLE pool, while the
    // snapshot's `accounts` rollup carries just the accounts currently holding a
    // lease — and an account an agent left has by definition lost its own.
    const moved = lease({
      ownerId: 'agent_worker',
      leaseId: 'agent_worker',
      accountId: 'acct-2222',
      failoverCount: 1,
      selectionKind: 'failover',
      previousAccountId: 'acct-1111',
    })
    const projected = leaseSnapshot(
      fakeReader({
        leases: [moved],
        // acct-1111 holds no lease any more, yet the pool still knows its alias.
        accounts: [{ accountId: 'acct-2222', leaseCount: 1, holders: ['audit the auth path'] }],
        aliases: { 'acct-1111': 'aurora', 'acct-2222': 'bluesky' },
      }),
      { agent_worker: localAgentTask({ agentId: 'agent_worker' }) },
    )
    expect(projected.owners[0]?.selectionKind).toBe('failover')
    expect(projected.owners[0]?.movedFrom).toEqual({
      accountId: 'acct-1111',
      accountAlias: 'aurora',
    })
    // The rollup genuinely does not contain it, which is why the renderer cannot.
    expect(projected.accounts.map(account => account.accountId)).toEqual(['acct-2222'])
  })

  test('movedFrom is omitted when the pool no longer knows that account', () => {
    // /delete-account: the lease still remembers the id, the pool does not. Emitting
    // a bare id here would put it back on screen, which is what this change removed.
    const projected = leaseSnapshot(
      fakeReader({
        leases: [
          lease({
            ownerId: 'agent_worker',
            leaseId: 'agent_worker',
            selectionKind: 'repaired',
            previousAccountId: 'acct-deleted',
          }),
        ],
        aliases: { 'acct-1111': 'work-laptop' },
      }),
      { agent_worker: localAgentTask({ agentId: 'agent_worker' }) },
    )
    expect(projected.owners[0]?.movedFrom).toBeUndefined()
    expect(JSON.stringify(projected)).not.toContain('acct-deleted')
  })

  test('an un-aliased source account crosses as a null alias, never as bare text', () => {
    const projected = leaseSnapshot(
      fakeReader({
        leases: [
          lease({
            ownerId: 'agent_worker',
            leaseId: 'agent_worker',
            selectionKind: 'failover',
            previousAccountId: 'acct-3333',
          }),
        ],
        aliases: { 'acct-3333': null },
      }),
      { agent_worker: localAgentTask({ agentId: 'agent_worker' }) },
    )
    expect(projected.owners[0]?.movedFrom).toEqual({
      accountId: 'acct-3333',
      accountAlias: null,
    })
  })

  test('main lease leads, then the live workers that hold one', () => {
    const main = lease({
      leaseId: 'lease:main:acct-1111',
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      strategy: 'follow-main',
      selectionReason: 'main lease pinned to pool activeIndex',
    })
    const worker = lease({ ownerId: 'agent_worker', leaseId: 'agent_worker' })
    const snapshot = leaseSnapshot(
      fakeReader({
        mainLease: main,
        leases: [main, worker],
        aliases: { 'acct-1111': 'work-laptop' },
      }),
      { agent_worker: localAgentTask({ agentId: 'agent_worker' }) },
    )

    expect(snapshot.owners.map(owner => owner.ownerId)).toEqual([
      'main-thread',
      'agent_worker',
    ])
    expect(snapshot.owners[0]!.ownerType).toBe('main')
    expect(snapshot.owners[0]!.accountAlias).toBe('work-laptop')
    expect(snapshot.owners[1]!.accountAlias).toBe('work-laptop')
  })

  test('a worker with no lease contributes no row (the Anthropic-path session)', () => {
    const snapshot = leaseSnapshot(
      fakeReader({ leases: [] }),
      { agent_worker: localAgentTask({ agentId: 'agent_worker' }) },
    )
    expect(snapshot.owners).toEqual([])
    expect(snapshot.accounts).toEqual([])
  })

  test('non-local_agent tasks are never asked for a lease', () => {
    const bash = {
      ...createTaskStateBase('bash_1', 'local_bash', 'npm test'),
      type: 'local_bash',
      status: 'running',
    } as unknown as TaskState
    const asked: string[] = []
    const reader = fakeReader()
    const spy: LeaseReader = {
      ...reader,
      leaseForOwner: ownerId => {
        asked.push(ownerId)
        return reader.leaseForOwner(ownerId)
      },
    }
    leaseSnapshot(spy, { bash_1: bash })
    // Only the main lease is looked up (the engine snapshot carried none here);
    // the bash task's id is never treated as a lease owner.
    expect(asked).toEqual(['main-thread'])
  })

  test('the account rollup carries only accounts that actually hold a lease', () => {
    const snapshot = leaseSnapshot(
      fakeReader({
        accounts: [
          { accountId: 'acct-1111', leaseCount: 2, holders: ['Main thread', 'audit'] },
          { accountId: 'acct-2222', leaseCount: 0, holders: [] },
        ],
        aliases: { 'acct-1111': 'work-laptop', 'acct-2222': null },
      }),
      {},
    )
    expect(snapshot.accounts).toHaveLength(1)
    expect(snapshot.accounts[0]).toEqual({
      accountId: 'acct-1111',
      accountAlias: 'work-laptop',
      leaseCount: 2,
      holders: ['Main thread', 'audit'],
    })
  })

  test('failover count and reason survive; engine reason text is length-capped', () => {
    const long = 'x'.repeat(500)
    const snapshot = leaseSnapshot(
      fakeReader({
        leases: [
          lease({
            ownerId: 'agent_worker',
            failoverCount: 2,
            selectionReason: long,
            lastFailureReason: long,
          }),
        ],
      }),
      { agent_worker: localAgentTask({ agentId: 'agent_worker' }) },
    )
    const row = snapshot.owners[0]!
    expect(row.failoverCount).toBe(2)
    expect(row.selectionReason.length).toBe(240)
    expect(row.lastFailureReason?.length).toBe(240)
  })

  test('a released lease is projected, not dropped (the roster dims it)', () => {
    const snapshot = leaseSnapshot(
      fakeReader({
        leases: [lease({ ownerId: 'agent_worker', state: 'released' })],
      }),
      { agent_worker: localAgentTask({ agentId: 'agent_worker' }) },
    )
    expect(snapshot.owners[0]!.state).toBe('released')
  })
})

describe('domain wiring', () => {
  test('getSnapshot reads the live store and is throw-free on a bad read', () => {
    const store = {
      getState: () => ({ tasks: { agent_worker: localAgentTask({ agentId: 'agent_worker' }) } }),
      subscribe: () => () => {},
    } as unknown as AppStateStore
    const domain = createSidecarLeaseDomain(store, {
      reader: fakeReader({ leases: [lease({ ownerId: 'agent_worker' })] }),
    })
    expect(domain.getSnapshot()?.owners).toHaveLength(1)

    const brokenReader: LeaseReader = {
      snapshot: () => {
        throw new Error('pool exploded')
      },
      leaseForOwner: () => undefined,
      accountAliases: () => new Map(),
    }
    const broken = createSidecarLeaseDomain(store, { reader: brokenReader })
    expect(broken.getSnapshot()).toBeNull()
  })

  test('subscribe rides the app-state store (a worker spawn moves leases)', () => {
    const listeners: Array<() => void> = []
    let unsubscribed = 0
    const store = {
      getState: () => ({ tasks: {} }),
      subscribe: (fn: () => void) => {
        listeners.push(fn)
        return () => {
          unsubscribed += 1
        }
      },
    } as unknown as AppStateStore
    let notified = 0
    const stop = createSidecarLeaseDomain(store, { reader: fakeReader() }).subscribe(
      () => {
        notified += 1
      },
    )
    expect(listeners).toHaveLength(1)
    listeners[0]!()
    expect(notified).toBe(1)
    stop()
    expect(unsubscribed).toBe(1)
  })
})

describe('the join key against the real engine lease manager', () => {
  test('the roster agentId is a live lookup key in the engine lease map', () => {
    // `AgentTool` registers a worker lease under the subagent's agentId
    // (`AgentTool.tsx:1226` async / `:1354` sync). Seeding is the pool-free way to
    // put a lease there; the LOOKUP below is the engine's real
    // `getCodexLeaseForOwner`, and the worker id comes from the REAL roster
    // projection, so nothing about the join is hand-asserted.
    const agentId = 'agent_join_probe'
    seedCodexLeaseForTest({
      ownerId: agentId,
      ownerType: 'subagent',
      ownerLabel: 'audit the auth path',
      accountId: 'acct-1111',
    })

    const tasks = { [agentId]: localAgentTask({ agentId }) }
    const roster = agentModeSnapshot(tasks, null, true)
    expect(roster.workers).toHaveLength(1)
    const workerAgentId = roster.workers[0]!.agentId

    const projected = leaseSnapshot(
      {
        snapshot: () => getCodexLeaseSnapshot(),
        leaseForOwner: getCodexLeaseForOwner,
        accountAliases: () => new Map([['acct-1111', 'work-laptop']]),
      },
      tasks,
    )

    const workerRow = projected.owners.find(row => row.ownerType === 'subagent')
    expect(workerRow).toBeDefined()
    expect(workerRow!.ownerId).toBe(workerAgentId)
    expect(workerRow!.accountAlias).toBe('work-laptop')
  })

  test('the engine seeds a main lease under the id query.ts uses', () => {
    seedCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      accountId: 'acct-1111',
    })
    expect(getCodexLeaseSnapshot().mainLease?.ownerId).toBe('main-thread')
  })
})

describe('redaction', () => {
  test('the snapshot frame is secretGuard-clean', () => {
    const snapshot = leaseSnapshot(
      fakeReader({
        mainLease: lease({
          ownerId: 'main-thread',
          ownerType: 'main',
          ownerLabel: 'Main thread',
        }),
        leases: [
          lease({ ownerId: 'main-thread', ownerType: 'main', ownerLabel: 'Main thread' }),
        ],
        accounts: [
          { accountId: 'acct-1111', leaseCount: 1, holders: ['Main thread'] },
        ],
        aliases: { 'acct-1111': 'work-laptop' },
      }),
      {},
    )
    const frame: LeaseSnapshotFrame = {
      kind: 'lease.snapshot',
      protocolVersion: 1,
      sessionId: 's1',
      leases: snapshot,
    }
    expect(scanForSecrets(frame).ok).toBe(true)
  })

  test('no credential-shaped key exists on the projected shape at all', () => {
    const snapshot = leaseSnapshot(
      fakeReader({ leases: [lease({ ownerId: 'agent_worker' })] }),
      { agent_worker: localAgentTask({ agentId: 'agent_worker' }) },
    )
    const keys = Object.keys(snapshot.owners[0]!)
    for (const forbidden of [
      'accessToken',
      'refreshToken',
      'idToken',
      'vaultFilePath',
      'email',
    ]) {
      expect(keys).not.toContain(forbidden)
    }
  })
})
