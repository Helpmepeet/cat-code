/**
 * Agent-mode / Orchestrator read-seam (P4-8, D2 `decisions/AGENT-CHROME.md`) —
 * the domain recipe (`docs/migration/backlog/phase4.md` Standing rules) applied
 * to the real orchestrator worker model. Two real engine feeds, joined at the
 * trust boundary and served as ONE redacted display snapshot (never a mock
 * worker object — D2 C5):
 *
 *   1. Session plane (D2 §4.2) — the engine's PERSISTED agent-mode state, read
 *      through the engine's OWN exact-session entry point `readSessionState`
 *      (`src/agent-mode/sessionState.ts`), NOT a hand-rolled file parse. It
 *      supplies the objective, run phase, and persisted workers for THIS engine
 *      session. Best-effort: a non-agent-mode session has no
 *      `.agent-mode-state.json`, so this degrades to empty. Engine continuity
 *      discovery remains an engine-only concern and is not imported into the
 *      desktop snapshot.
 *   2. Live plane — the `local_agent` workers this session delegated via the Agent
 *      tool (`AppState.tasks`, the SAME store P4-9's tasks domain reads). Reading
 *      the raw `LocalAgentTaskState` here (not the P4-9 wire item) also surfaces
 *      `blockReason`/`verdict`, which the tasks snapshot omits. `handoffStatus:
 *      'blocked'` is the real "waiting on orchestrator" state
 *      (`src/tasks/LocalAgentTask/LocalAgentTask.tsx:184`).
 *
 * Read-only; no renderer writes; no new inbound vocabulary. secretGuard-clean by
 * construction — identity/role/status/description text only, never a token.
 */
import { isAgentMode, matchSessionMode } from '../../src/agent-mode/agentMode.js'
import {
  readSessionState,
  type AgentModeSessionState,
  type AgentModeWorkerSession,
} from '../../src/agent-mode/sessionState.js'
import { getSessionId } from '../../src/bootstrap/state.js'
import type { AppStateStore } from '../../src/state/AppStateStore.js'
import type { TaskState } from '../../src/tasks/types.js'
import type {
  AgentModeRunPhase,
  AgentModeSnapshot,
  AgentModeWorkerItem,
} from '../shared/protocol.js'

/** The redacted outcome of a set-agent-mode write (no transport, no secret). */
export type AgentModeSetResult = {
  ok: boolean
  message: string
  /** Whether the switch actually flipped the mode (drives snapshot re-broadcast). */
  changed: boolean
}

/**
 * The engine agent-mode ops, behind a seam (P4-8b). The real implementation
 * (`createRealAgentModeExecutor`) wires the engine's OWN `isAgentMode` /
 * `matchSessionMode`; tests inject a fake so a headless round-trip proves the
 * wiring without mutating the real `process.env` (§10 — mirrors
 * accountsDomain's / workspaceTrustDomain's executor seam).
 */
export type AgentModeExecutor = {
  /** Is this session in agent mode right now? (real: `isAgentMode()`, agentMode.ts:37) */
  isActive(): boolean
  /**
   * Switch this session's runtime mode via the engine's OWN `matchSessionMode`
   * (agentMode.ts:102) — the SAME function the `/agent` command uses. Sets/clears
   * `CLAUDE_CODE_AGENT_MODE` in THIS process only (N-process, LOCKED) and logs
   * `tengu_agent_mode_switched`. No respawn, no session-lifecycle change.
   */
  setMode(active: boolean): void
}

export function createRealAgentModeExecutor(): AgentModeExecutor {
  return {
    isActive() {
      return isAgentMode()
    },
    setMode(active) {
      // `matchSessionMode` is idempotent (returns undefined when already in mode)
      // and clears the coordinator flag on both branches — the engine's own switch.
      matchSessionMode(active ? 'agent' : 'normal')
    },
  }
}

export type SidecarAgentModeDomain = {
  /**
   * Live read-only orchestrator snapshot. Async because the session plane is a
   * file-backed engine read (`readSessionState`); the live plane is
   * a sync read over the same app-state store the runtime mutates.
   */
  getSnapshot(): Promise<AgentModeSnapshot>
  /**
   * P4-8b — set this session's agent mode on/off through the engine's own
   * `matchSessionMode`, re-read `isActive`, and report whether the mode flipped.
   * Idempotent (already in the requested mode → ok, unchanged). Throw-free.
   */
  setActive(active: boolean): AgentModeSetResult
  /**
   * Record that this worker was dismissed, so the session plane stops re-supplying
   * the row the live plane just gave up (see `agentModeSnapshot`). Called only
   * after a `task.dismiss` the live store actually accepted; process-local and
   * session-scoped, exactly like the live plane it shadows — nothing is written to
   * the engine's persisted state, which stays the engine's own record.
   */
  noteWorkerDismissed(agentId: string): void
  subscribe(listener: () => void): () => void
}

export function createSidecarAgentModeDomain(
  appStateStore: AppStateStore,
  options: { executor?: AgentModeExecutor } = {},
): SidecarAgentModeDomain {
  const executor = options.executor ?? createRealAgentModeExecutor()
  const dismissed = new Set<string>()
  return {
    async getSnapshot() {
      const persisted = await readPersistedAgentModeState()
      const state = appStateStore.getState()
      // Read `active` through the executor so the spawn snapshot, the set path,
      // and any injected test fake all share ONE truth source (real: isAgentMode()).
      return agentModeSnapshot(
        state.tasks,
        persisted,
        executor.isActive(),
        dismissed,
      )
    },
    noteWorkerDismissed(agentId) {
      dismissed.add(agentId)
    },
    setActive(active) {
      const wasActive = executor.isActive()
      try {
        executor.setMode(active)
        const nowActive = executor.isActive()
        if (nowActive !== active) {
          return {
            ok: false,
            message: 'Agent Mode switch did not take effect.',
            changed: wasActive !== nowActive,
          }
        }
        const changed = wasActive !== nowActive
        return {
          ok: true,
          message: changed
            ? active
              ? 'Agent Mode enabled for this session.'
              : 'Agent Mode disabled for this session.'
            : active
              ? 'Agent Mode already enabled.'
              : 'Agent Mode already disabled.',
          changed,
        }
      } catch (error) {
        return {
          ok: false,
          message: `Could not switch Agent Mode: ${
            error instanceof Error ? error.message : String(error)
          }`,
          changed: false,
        }
      }
    },
    // Worker spawns/completions mutate `AppState.tasks`, and the engine writes the
    // agent-mode state file on the same activity, so re-reading the persisted plane
    // on every store change keeps both planes fresh without a second subscription.
    subscribe(listener) {
      return appStateStore.subscribe(listener)
    },
  }
}

async function readPersistedAgentModeState(): Promise<AgentModeSessionState | null> {
  try {
    const sessionId = getSessionId()
    if (!sessionId) return null
    return await readSessionState(sessionId)
  } catch {
    // Absent/unreadable state file (the common non-agent-mode case) → degrade to
    // empty, never throw (display = degrade gracefully; the live plane still fills).
    return null
  }
}

/**
 * Pure snapshot builder over the two real feeds — no I/O, so it is unit-testable
 * with hand-built `TaskState` / persisted-state fixtures.
 *
 * Union policy: the live `local_agent` workers are authoritative for CURRENT
 * workers (they carry the real handoff gate + block reason + verdict). Persisted
 * workers from this same engine session are added only when NOT already
 * represented live (matched by handle). A plain de-dupe union, never a
 * field-merge, so no fragile overlay of two shapes. Cross-session continuity is
 * intentionally left to the engine's resume machinery and does not enter this
 * desktop snapshot.
 *
 * `dismissed` is the counterweight to that union (CC-32 follow-up). Handle-based
 * de-dupe means a live worker MASKS its own persisted twin, so evicting the live
 * task un-masks the twin and the row the operator just dismissed reappears from
 * the other plane — the dismiss would visibly self-cancel in exactly the agent-mode
 * sessions that have a state file. Suppressing the twin here keeps the dismissal
 * effective. It is deliberately scoped to the PERSISTED plane: a live worker is
 * removed by the engine's own eviction, and hiding one the engine still holds
 * would be a display lie about a row that is genuinely still there.
 */
export function agentModeSnapshot(
  tasks: Record<string, TaskState> | undefined,
  persisted: AgentModeSessionState | null,
  active: boolean,
  dismissed: ReadonlySet<string> = new Set(),
): AgentModeSnapshot {
  const liveWorkers = Object.values(tasks ?? {})
    .filter((task): task is Extract<TaskState, { type: 'local_agent' }> =>
      task.type === 'local_agent',
    )
    .map(toLiveWorkerItem)

  const liveHandles = new Set(
    liveWorkers
      .map(worker => normalizeHandle(worker.handle))
      .filter((handle): handle is string => handle !== null),
  )

  const persistedExtra = (persisted?.knownWorkers ?? [])
    .filter(worker => {
      if (dismissed.has(worker.agentId)) return false
      const handle = normalizeHandle(worker.handle ?? null)
      return handle === null || !liveHandles.has(handle)
    })
    .map(toPersistedWorkerItem)

  return {
    active,
    objective: persisted?.objective ?? '',
    phase: (persisted?.currentPhase ?? 'planning') as AgentModeRunPhase,
    workers: [...liveWorkers, ...persistedExtra],
  }
}

function toLiveWorkerItem(
  task: Extract<TaskState, { type: 'local_agent' }>,
): AgentModeWorkerItem {
  return {
    // Prefer the subagent's own id (matches persisted `AgentModeWorkerSession.agentId`
    // for de-dupe / cross-plane identity); fall back to the task id.
    agentId: task.agentId ?? task.id,
    handle: task.agentName ?? null,
    role: task.agentType,
    status: foldTaskStatus(task.status),
    description: task.description ?? null,
    origin: 'current',
    isBackgrounded: task.isBackgrounded,
    ...(task.handoffStatus ? { handoffStatus: task.handoffStatus } : {}),
    ...(task.handoffStatus === 'blocked' && task.blockReason
      ? { blockReason: task.blockReason }
      : {}),
    ...(task.verdict ? { verdict: task.verdict } : {}),
  }
}

function toPersistedWorkerItem(worker: AgentModeWorkerSession): AgentModeWorkerItem {
  return {
    agentId: worker.agentId,
    handle: worker.handle ?? null,
    role: worker.role ?? null,
    status: worker.status,
    description: worker.description ?? null,
    ...(worker.synthesisStatus ? { synthesisStatus: worker.synthesisStatus } : {}),
    ...(worker.origin ? { origin: worker.origin } : {}),
    ...(worker.resumable !== undefined ? { resumable: worker.resumable } : {}),
    ...(worker.outputSummary ? { outputSummary: worker.outputSummary } : {}),
  }
}

/** A queued (`pending`) local_agent is in-flight — fold to `running` for the display union. */
function foldTaskStatus(
  status: TaskState['status'],
): AgentModeWorkerItem['status'] {
  return status === 'pending' ? 'running' : status
}

function normalizeHandle(handle: string | null): string | null {
  if (!handle) return null
  const stripped = handle.replace(/^@/, '').trim().toLowerCase()
  return stripped.length > 0 ? stripped : null
}
