import { expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTaskStateBase } from '../../src/Task.js'
import {
  buildAgentModeSessionState,
  readSessionState,
  type AgentModeSessionState,
  type AgentModeWorkerSession,
} from '../../src/agent-mode/sessionState.js'
import type { LocalAgentTaskState } from '../../src/tasks/LocalAgentTask/LocalAgentTask.js'
import type { TaskState } from '../../src/tasks/types.js'
import { isAgentMode } from '../../src/agent-mode/agentMode.js'
import type { AppStateStore } from '../../src/state/AppStateStore.js'
import type { AgentModeSnapshotFrame } from '../shared/protocol.js'
import { scanForSecrets } from '../shared/secretGuard.js'
import {
  agentModeSnapshot,
  createSidecarAgentModeDomain,
  type AgentModeExecutor,
} from './agentModeDomain.js'

/** Minimal AppStateStore fake — the set path never touches tasks; getSnapshot only
 * reads `.tasks` (empty here) + the executor's `isActive`. */
function fakeStore(): AppStateStore {
  return {
    getState: () => ({ tasks: {} }),
    subscribe: () => () => {},
  } as unknown as AppStateStore
}

/** A fake agent-mode executor — records the switch and reflects it, so a headless
 * round-trip proves the domain wiring without mutating the real `process.env`. */
function fakeExecutor(initial = false): {
  executor: AgentModeExecutor
  calls: boolean[]
} {
  let active = initial
  const calls: boolean[] = []
  return {
    executor: {
      isActive: () => active,
      setMode: (next: boolean) => {
        calls.push(next)
        active = next
      },
    },
    calls,
  }
}

function agentTask(over: Partial<LocalAgentTaskState> = {}): LocalAgentTaskState {
  return {
    ...createTaskStateBase('a1', 'local_agent', 'Implement the thing'),
    type: 'local_agent',
    status: 'running',
    agentId: 'agent-1',
    prompt: 'Implement the thing',
    agentType: 'general-purpose',
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
    ...over,
  }
}

function worker(over: Partial<AgentModeWorkerSession> = {}): AgentModeWorkerSession {
  return {
    agentId: 'w-1',
    role: 'agent-mode-coding-worker',
    description: 'Refactor the module',
    status: 'completed',
    worktreePath: null,
    ...over,
  }
}

function persisted(
  workers: AgentModeWorkerSession[],
  objective = 'Ship the feature',
): AgentModeSessionState {
  return buildAgentModeSessionState({
    ledger: { objective, run_status: 'executing', next_action: '' },
    workerSessions: workers,
  })
}

test('a live blocked local_agent surfaces the real handoff gate + block reason (waiting-on-orchestrator source)', () => {
  const tasks: Record<string, TaskState> = {
    a1: agentTask({
      agentId: 'w-blocked',
      agentName: 'Turing',
      agentType: 'implementor',
      status: 'completed',
      handoffStatus: 'blocked',
      blockReason: 'Which auth strategy should I use?',
    }),
  }
  const snap = agentModeSnapshot(tasks, null, false)
  expect(snap.workers).toHaveLength(1)
  expect(snap.workers[0]).toMatchObject({
    agentId: 'w-blocked',
    handle: 'Turing',
    role: 'implementor',
    status: 'completed',
    origin: 'current',
    handoffStatus: 'blocked',
    blockReason: 'Which auth strategy should I use?',
  })
})

test('a live verifier surfaces its real verdict; a running task folds pending→running', () => {
  const snap = agentModeSnapshot(
    {
      v1: agentTask({ agentId: 'w-verify', agentName: 'Noether', agentType: 'verification', status: 'completed', verdict: 'PASS' }),
      p1: agentTask({ agentId: 'w-pending', agentName: 'Bell', status: 'pending' }),
    },
    null,
    false,
  )
  const byId = Object.fromEntries(snap.workers.map(w => [w.agentId, w]))
  expect(byId['w-verify']).toMatchObject({ verdict: 'PASS', role: 'verification' })
  expect(byId['w-pending']).toMatchObject({ status: 'running' })
})

test('persisted workers retain resumability and synthesis metadata in the pure builder', () => {
  const state = persisted([
    worker({
      agentId: 'w-prior',
      handle: 'Hopper',
      role: 'agent-mode-verifier',
      status: 'completed',
      synthesisStatus: 'synthesized',
      origin: 'prior',
      resumable: true,
      outputSummary: 'Reviewed the diff, no blockers.',
    }),
  ])
  const snap = agentModeSnapshot(undefined, state, true)
  expect(snap.active).toBe(true)
  expect(snap.objective).toBe('Ship the feature')
  expect(snap.workers).toHaveLength(1)
  expect(snap.workers[0]).toMatchObject({
    agentId: 'w-prior',
    handle: 'Hopper',
    origin: 'prior',
    resumable: true,
    synthesisStatus: 'synthesized',
    outputSummary: 'Reviewed the diff, no blockers.',
  })
})

test('de-dupes by handle: a live worker wins over a same-handle persisted worker (no field-merge overlay)', () => {
  const tasks: Record<string, TaskState> = {
    a1: agentTask({ agentId: 'w-live', agentName: 'Turing', status: 'running' }),
  }
  const state = persisted([
    worker({ agentId: 'w-persisted', handle: '@turing', status: 'completed', synthesisStatus: 'pending' }),
    worker({ agentId: 'w-other', handle: 'Lovelace', status: 'completed' }),
  ])
  const snap = agentModeSnapshot(tasks, state, true)
  const handles = snap.workers.map(w => w.handle)
  // Turing appears once (the live one, status running), plus the un-matched Lovelace.
  expect(snap.workers.filter(w => (w.handle ?? '').toLowerCase().replace(/^@/, '') === 'turing')).toHaveLength(1)
  expect(snap.workers.find(w => w.handle === 'Turing')).toMatchObject({ agentId: 'w-live', status: 'running' })
  expect(handles).toContain('Lovelace')
})

/* CC-32 follow-up — handle de-dupe means the live plane MASKS its persisted twin,
 * so retiring the live task un-masks the twin unless the dismissal is recorded.
 * These two pin the before/after of that hole. */
test('CC-32 — without the dismissal record, evicting the live worker un-dedupes its persisted twin and the row comes back', () => {
  const state = persisted([
    worker({ agentId: 'w-live', handle: '@gauss', status: 'completed' }),
  ])
  const live: Record<string, TaskState> = {
    a1: agentTask({ agentId: 'w-live', agentName: 'Gauss', status: 'completed' }),
  }
  // Masked while the live task exists...
  expect(agentModeSnapshot(live, state, true).workers).toHaveLength(1)
  // ...and back the moment the live task is evicted. This is the self-cancel.
  const afterEviction = agentModeSnapshot(undefined, state, true)
  expect(afterEviction.workers.map(w => w.handle)).toEqual(['@gauss'])
})

test('CC-32 — a dismissed worker stays gone: the session plane no longer re-supplies its row after the live task is evicted', () => {
  const state = persisted([
    worker({ agentId: 'w-live', handle: '@gauss', status: 'completed' }),
    worker({ agentId: 'w-other', handle: 'Lovelace', status: 'completed' }),
  ])
  const snap = agentModeSnapshot(undefined, state, true, new Set(['w-live']))
  // Only the dismissed one is suppressed — the rest of the plane is untouched.
  expect(snap.workers.map(w => w.handle)).toEqual(['Lovelace'])
})

test('an absent agent-mode session degrades to an empty, well-formed snapshot', () => {
  expect(agentModeSnapshot(undefined, null, false)).toEqual({
    active: false,
    objective: '',
    phase: 'planning',
    workers: [],
  })
})

test('LIVE PATH: a real persisted .agent-mode-state.json read via the engine flows into the snapshot', async () => {
  // Prove the session plane end-to-end through the engine's OWN read entry point
  // (readSessionState → my builder), on the real on-disk AgentSessionState shape
  // (maps keyed by agentId/handle), not a hand-rolled parse.
  const dir = await mkdtemp(join(tmpdir(), 'p4-8-agentmode-'))
  const statePath = join(dir, 'sess-live.agent-mode-state.json')
  const onDisk = {
    sessionId: 'sess-live',
    mode: 'agent',
    objective: 'Deliver the orchestrator surface',
    activeWorkers: { Turing: { role: 'agent-mode-coding-worker', agentId: 'w-live-1' } },
    knownWorkers: {
      'w-live-1': {
        agentId: 'w-live-1',
        handle: 'Turing',
        role: 'agent-mode-coding-worker',
        description: 'Build the roster',
        status: 'running',
        worktreePath: null,
      },
    },
  }
  await writeFile(statePath, JSON.stringify(onDisk, null, 2))

  const state = await readSessionState('sess-live', statePath)
  expect(state).not.toBeNull()
  const snap = agentModeSnapshot(undefined, state, true)
  expect(snap.objective).toBe('Deliver the orchestrator surface')
  expect(snap.workers).toHaveLength(1)
  expect(snap.workers[0]).toMatchObject({
    agentId: 'w-live-1',
    handle: 'Turing',
    role: 'agent-mode-coding-worker',
    status: 'running',
    origin: 'current',
  })
})

test('LIVE PATH: exact session snapshots do not import workers from another session in the same project', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'p4-8-agentmode-project-'))
  const configHome = mkdtempSync(join(tmpdir(), 'p4-8-agentmode-config-'))
  const fixture = join(dirname(fileURLToPath(import.meta.url)), 'agentModeDomain.fixture.ts')
  try {
    const proc = Bun.spawn(
      ['bun', 'run', fixture, projectDir, 'session-a', 'session-b'],
      {
        cwd: join(dirname(fileURLToPath(import.meta.url)), '..', '..'),
        env: { ...process.env, CLAUDE_CONFIG_DIR: configHome },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect(code, stderr).toBe(0)

    const result = JSON.parse(stdout.trim()) as {
      a: AgentModeSnapshotFrame['agentMode']
      b: AgentModeSnapshotFrame['agentMode']
    }
    expect(result.a.workers).toHaveLength(1)
    expect(result.a.workers[0]).toMatchObject({
      agentId: 'worker-a',
      handle: 'Turing',
      origin: 'current',
    })
    expect(result.b.workers).toEqual([])
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
    rmSync(configHome, { recursive: true, force: true })
  }
})

test('P4-8b setActive(true) switches on via the executor; snapshot reflects it; idempotent no-op', async () => {
  const { executor, calls } = fakeExecutor(false)
  const domain = createSidecarAgentModeDomain(fakeStore(), { executor })

  const on = domain.setActive(true)
  expect(calls).toEqual([true])
  expect(on).toMatchObject({ ok: true, changed: true })
  expect((await domain.getSnapshot()).active).toBe(true)

  // Already on → idempotent: still ok, but changed:false (no re-broadcast).
  const again = domain.setActive(true)
  expect(again).toMatchObject({ ok: true, changed: false })
  expect(calls).toEqual([true, true])
})

test('P4-8b setActive(false) switches off via the executor; snapshot reflects it', async () => {
  const { executor, calls } = fakeExecutor(true)
  const domain = createSidecarAgentModeDomain(fakeStore(), { executor })

  const off = domain.setActive(false)
  expect(calls).toEqual([false])
  expect(off).toMatchObject({ ok: true, changed: true })
  expect((await domain.getSnapshot()).active).toBe(false)
})

test('P4-8b LIVE: the real executor drives matchSessionMode → isAgentMode flips (env save/restore)', () => {
  const prevAgent = process.env.CLAUDE_CODE_AGENT_MODE
  const prevCoord = process.env.CLAUDE_CODE_COORDINATOR_MODE
  try {
    delete process.env.CLAUDE_CODE_AGENT_MODE
    delete process.env.CLAUDE_CODE_COORDINATOR_MODE
    // Default (real) executor → the engine's own matchSessionMode.
    const domain = createSidecarAgentModeDomain(fakeStore())
    expect(isAgentMode()).toBe(false)

    // `isAgentMode()` reads `process.env.CLAUDE_CODE_AGENT_MODE`, so these flips
    // prove `matchSessionMode` set/cleared that exact var through the real executor.
    const on = domain.setActive(true)
    expect(on).toMatchObject({ ok: true, changed: true })
    expect(isAgentMode()).toBe(true)

    const off = domain.setActive(false)
    expect(off).toMatchObject({ ok: true, changed: true })
    expect(isAgentMode()).toBe(false)
  } finally {
    if (prevAgent === undefined) delete process.env.CLAUDE_CODE_AGENT_MODE
    else process.env.CLAUDE_CODE_AGENT_MODE = prevAgent
    if (prevCoord === undefined) delete process.env.CLAUDE_CODE_COORDINATOR_MODE
    else process.env.CLAUDE_CODE_COORDINATOR_MODE = prevCoord
  }
})

test('the outbound agent-mode.snapshot frame is secretGuard-clean', () => {
  const snap = agentModeSnapshot(
    {
      a1: agentTask({
        agentId: 'w-1',
        agentName: 'Turing',
        blockReason: 'need the Authorization header value to proceed',
      }),
    },
    persisted([worker({ handle: 'Hopper' })]),
    true,
  )
  const frame: AgentModeSnapshotFrame = {
    kind: 'agent-mode.snapshot',
    protocolVersion: 1,
    sessionId: 'sess-1',
    agentMode: snap,
  }
  // Worker identity/role/status/description carry no secret-KEYED names; the guard
  // runs over the new frame kind and passes by construction (no tokens leave the engine).
  expect(scanForSecrets(frame).ok).toBe(true)
})
