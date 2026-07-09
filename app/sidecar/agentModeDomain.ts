/**
 * Agent-mode / Orchestrator read-seam (P4-8, D2 `decisions/AGENT-CHROME.md`) —
 * the domain recipe (`docs/migration/backlog/phase4.md` Standing rules) applied
 * to the real orchestrator worker model. Two real engine feeds, joined at the
 * trust boundary and served as ONE redacted display snapshot (never a mock
 * worker object — D2 C5):
 *
 *   1. Session plane (D2 §4.2) — the engine's PERSISTED agent-mode state, read
 *      through the engine's OWN entry point `readSessionStateWithContinuity`
 *      (`src/agent-mode/sessionState.ts:691`), NOT a hand-rolled file parse. It
 *      supplies the objective, run phase, prior-session continuity workers
 *      (resumable/stale) and the synthesis lifecycle. Best-effort: a non-agent-mode
 *      session has no `.agent-mode-state.json`, so this degrades to empty.
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
import { isAgentMode } from '../../src/agent-mode/agentMode.js'
import {
  readSessionStateWithContinuity,
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

export type SidecarAgentModeDomain = {
  /**
   * Live read-only orchestrator snapshot. Async because the session plane is a
   * file-backed engine read (`readSessionStateWithContinuity`); the live plane is
   * a sync read over the same app-state store the runtime mutates.
   */
  getSnapshot(): Promise<AgentModeSnapshot>
  subscribe(listener: () => void): () => void
}

export function createSidecarAgentModeDomain(
  appStateStore: AppStateStore,
): SidecarAgentModeDomain {
  return {
    async getSnapshot() {
      const persisted = await readPersistedAgentModeState()
      const state = appStateStore.getState()
      return agentModeSnapshot(state.tasks, persisted, isAgentMode())
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
    return await readSessionStateWithContinuity(sessionId)
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
 * workers are added only when NOT already represented live (matched by handle) —
 * this is where prior-session continuity workers (resumable/stale) and any
 * agent-mode worker with a synthesis lifecycle but no live task come from. A plain
 * de-dupe union, never a field-merge, so no fragile overlay of two shapes.
 */
export function agentModeSnapshot(
  tasks: Record<string, TaskState> | undefined,
  persisted: AgentModeSessionState | null,
  active: boolean,
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
