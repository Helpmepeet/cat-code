/**
 * Codex lease state (P4-32b, L1 — `decisions/ORCHESTRATOR-IN-SESSION.md` §7,
 * ruled 2026-07-30 §10): the renderer half of the read-only `lease.snapshot`
 * seam. Per-session snapshots plus read-time selectors; nothing is stored derived
 * and nothing is ever renderer-authored (there is no lease verb).
 *
 * The lease plane answers "which Codex account is each agent in THIS session's
 * swarm leasing right now", which is why it lives beside the worker roster rather
 * than on the global Accounts page.
 */
import type {
  LeaseOwnerRow,
  LeaseSnapshot,
  LeaseState as LeaseLifecycle,
  ServerFrame,
  SessionId,
} from '../../shared/protocol.js'

export type LeaseStateStore = {
  bySession: Record<SessionId, LeaseSnapshot | undefined>
}

export type LeaseAction = { type: 'frame'; frame: ServerFrame }

export function createLeaseState(): LeaseStateStore {
  return { bySession: {} }
}

export function reduceLeaseState(
  state: LeaseStateStore,
  action: LeaseAction,
): LeaseStateStore {
  const { frame } = action

  if (frame.kind === 'lease.snapshot') {
    return {
      bySession: { ...state.bySession, [frame.sessionId]: frame.leases },
    }
  }

  // A dead session's leases are gone with its engine process (the lease map is
  // per-process, in-memory) — drop the snapshot rather than show a stale one.
  if (frame.kind === 'lifecycle') {
    return {
      bySession: { ...state.bySession, [frame.sessionId]: undefined },
    }
  }

  return state
}

export function selectLeaseSnapshot(
  state: LeaseStateStore,
  sessionId: SessionId | null,
): LeaseSnapshot | null {
  const snapshot = sessionId ? state.bySession[sessionId] : undefined
  return snapshot ?? null
}

/* ── read-time derivations ─────────────────────────────────────────────────── */

/**
 * Lease lifecycle vocabulary (the prototype's `LEASE_STATE`,
 * `OrchestratorMode.jsx:598-602`) mapped onto the P0-2 tone tokens. Static class
 * literals only: an interpolated arbitrary value silently no-ops under Tailwind v4.
 */
export const LEASE_STATE_META: Record<
  LeaseLifecycle,
  { label: string; dot: string; text: string }
> = {
  active: { label: 'active', dot: 'bg-tone-good', text: 'text-tone-good' },
  released: { label: 'released', dot: 'bg-zinc-600', text: 'text-text-subtle' },
  failed: { label: 'failed', dot: 'bg-tone-danger', text: 'text-tone-danger' },
}

/**
 * The lease held by one owner, or null. `ownerId` is the subagent's `agentId`
 * (the roster's `AgentModeWorkerItem.agentId`) or `'main-thread'`; see the
 * protocol JOIN KEY note. Null is the ordinary case for an Anthropic-path
 * session or a worker that has not made a Codex request yet.
 */
export function selectLeaseForOwner(
  snapshot: LeaseSnapshot | null,
  ownerId: string | null,
): LeaseOwnerRow | null {
  if (!snapshot || !ownerId) return null
  return snapshot.owners.find(owner => owner.ownerId === ownerId) ?? null
}

/** Active-lease count — the Leases tab's count chip. */
export function selectActiveLeaseCount(snapshot: LeaseSnapshot | null): number {
  if (!snapshot) return 0
  return snapshot.owners.filter(owner => owner.state === 'active').length
}

/**
 * How long a lease has been held, as a DURATION (the prototype's `l.held`, shown
 * only for active leases). Deliberately not `formatRelativeTime`
 * (`sessionsCatalogState.ts:716`): that renders "4m ago", and this reads
 * "held 4m".
 */
export function leaseHeldLabel(createdAtMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - createdAtMs) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`
}

/** The account's display label: the pool's redacted alias, else its identifier. */
export function leaseAccountLabel(row: {
  accountId: string
  accountAlias: string | null
}): string {
  return row.accountAlias ?? row.accountId
}
