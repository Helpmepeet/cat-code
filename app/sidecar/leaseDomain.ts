/**
 * Codex lease read-seam (P4-32b, L1 — `decisions/ORCHESTRATOR-IN-SESSION.md` §7,
 * ruled 2026-07-30 §10). The W4 domain recipe (`accountsDomain.ts` header) applied
 * to the engine's real lease manager:
 *
 *  1. **Read-only OUTBOUND projection.** `getSnapshot()` reads the engine's OWN
 *     `getCodexLeaseSnapshot()` / `getCodexLeaseForOwner()`
 *     (`src/services/api/codexAccountLeaseManager.ts:163,194`) — the SAME lease map
 *     the request path mutates through `registerCodexLease`/`failoverCodexLease`.
 *     It re-implements no selection logic and never returns a raw engine record.
 *     There is NO lease verb: assignment, failover and release stay engine-side.
 *  2. **Secret owner is non-negotiable** (SECURITY-MINIMUM §4). `CodexLease`
 *     carries no credential field at all; the only account material projected is
 *     the `accountId` identifier plus the pool's redacted `alias` — exactly the
 *     policy `AccountStatus.id`/`.alias` already set. Engine-authored reason text
 *     is length-capped here so an unbounded upstream error body cannot ride out.
 *     `leaseDomain.test.ts` drives token-bearing pool fixtures through the
 *     projection and asserts the output is `secretGuard`-clean.
 *  3. **Throw-free.** A failed read returns null; the sidecar degrades and the
 *     attaching connection is never stranded.
 *  4. **Reactivity = emit-on-attach + store-driven re-emit (NOT a poll).** The
 *     lease map is a bare module singleton with no emitter, but leases move on
 *     exactly the events that mutate `AppState.tasks`: a worker spawn registers a
 *     lease when that worker is on the Codex path (`registerWorkerCodexLease`,
 *     `AgentTool.tsx`) and a worker finish releases one
 *     (`LocalAgentTask.tsx:388,554,581,817`). So this domain subscribes to the
 *     SAME app-state store that drives the `agent-mode.snapshot` re-broadcast.
 *
 * The owner set is deliberately NOT "every lease in the process": it is the main
 * lease plus the live `local_agent` workers of THIS session, so the snapshot is
 * session-scoped the way §7 requires.
 *
 * KNOWN AND CORRECT: the FIRST frame after attach is often empty. Leases only
 * exist once something has made a Codex request (`registerCodexLease` runs inside
 * a turn — `src/query.ts:325` main, `src/tools/AgentTool/AgentTool.tsx:1226`
 * worker), and the account pool loads through `init()`'s FIRE-AND-FORGET
 * `initAccountPool()` (`app/sidecar/initializeRuntime.ts:40` → `src/entrypoints/
 * init.ts`), so `getPoolStatus().initialized` can still be false at attach. An
 * empty roster is therefore the truth at that moment, and the renderer's empty
 * state says so; the store-driven re-broadcast fills it in as soon as a turn or a
 * worker moves. Do not "fix" this by polling the pool or by seeding a placeholder
 * lease.
 *
 * ZERO transport knowledge: frames, wire validation and limits stay in
 * `sidecarServer.ts`.
 */
import {
  getCodexLeaseForOwner,
  getCodexLeaseSnapshot,
  type CodexLease,
} from '../../src/services/api/codexAccountLeaseManager.js'
import { getPoolStatus } from '../../src/services/api/codexAccountPool.js'
import type { AppStateStore } from '../../src/state/AppStateStore.js'
import type { TaskState } from '../../src/tasks/types.js'
import type {
  LeaseAccountRow,
  LeaseOwnerRow,
  LeaseSelectionKind,
  LeaseSnapshot,
} from '../shared/protocol.js'
import { NON_LEASE_SELECTION_KINDS } from '../shared/protocol.js'

/**
 * The owner id the engine registers for the main thread's lease
 * (`src/query.ts:325` `registerCodexLease({ ownerId: 'main-thread', … })`). Also
 * the id `synthesizeMainLease` stamps when the pool has an active account but no
 * turn has run yet (`codexAccountLeaseManager.ts:433`).
 */
const MAIN_LEASE_OWNER_ID = 'main-thread'

/**
 * Cap on projected engine reason text. `selectionReason`/`lastFailureReason` are
 * engine-authored (`failoverCodexLease` passes an upstream `error.message`
 * through, `src/services/api/withRetry.ts:605,974`), so bound them rather than
 * relay an arbitrarily long provider body to the renderer.
 */
const MAX_REASON_CHARS = 240

/**
 * The engine lease reads, behind a seam. The real implementation wires the
 * engine's OWN lease manager + account pool; tests inject a fake so a headless
 * round-trip proves the wiring without a live pool (the `AgentModeExecutor` /
 * `AccountsCommandExecutor` idiom, `agentModeDomain.ts:54`).
 */
export type LeaseReader = {
  /** `getCodexLeaseSnapshot()` — main lease + this session's strategy + account rollup. */
  snapshot(): {
    mainLease: CodexLease | null
    strategy: LeaseSnapshot['strategy']
    accounts: Array<{ accountId: string; leaseCount: number; holders: string[] }>
  }
  /** `getCodexLeaseForOwner(ownerId)` — one known owner's live lease. */
  leaseForOwner(ownerId: string): CodexLease | undefined
  /** accountId → the pool's redacted alias. Never an email, never a token. */
  accountAliases(): Map<string, string | null>
}

export function createRealLeaseReader(): LeaseReader {
  return {
    snapshot() {
      return getCodexLeaseSnapshot()
    },
    leaseForOwner(ownerId) {
      return getCodexLeaseForOwner(ownerId)
    },
    accountAliases() {
      const aliases = new Map<string, string | null>()
      for (const account of getPoolStatus().accounts) {
        aliases.set(account.accountId, account.alias ?? null)
      }
      return aliases
    },
  }
}

export type SidecarLeaseDomain = {
  /**
   * Live read-only lease snapshot for THIS session. Throw-free: returns null when
   * the engine lease/pool read fails, which the sidecar treats as "emit nothing".
   */
  getSnapshot(): LeaseSnapshot | null
  subscribe(listener: () => void): () => void
}

export function createSidecarLeaseDomain(
  appStateStore: AppStateStore,
  options: { reader?: LeaseReader } = {},
): SidecarLeaseDomain {
  const reader = options.reader ?? createRealLeaseReader()
  return {
    getSnapshot() {
      try {
        return leaseSnapshot(reader, appStateStore.getState().tasks)
      } catch {
        return null
      }
    },
    subscribe(listener) {
      return appStateStore.subscribe(listener)
    },
  }
}

/**
 * Pure projection over the reader + the live task map — no I/O, so it is
 * unit-testable with hand-built fixtures.
 *
 * Owner order is main-first then worker order, which is the order the prototype's
 * roster renders (`OrchestratorMode.jsx:644-647` main, then subagents). A worker
 * with no lease contributes no row: a session on the Anthropic path, or one whose
 * workers have not made a Codex request yet, legitimately holds none.
 */
export function leaseSnapshot(
  reader: LeaseReader,
  tasks: Record<string, TaskState> | undefined,
): LeaseSnapshot {
  const engineSnapshot = reader.snapshot()
  const aliases = reader.accountAliases()

  const owners: LeaseOwnerRow[] = []
  const seen = new Set<string>()
  const mainLease =
    engineSnapshot.mainLease ?? reader.leaseForOwner(MAIN_LEASE_OWNER_ID)
  // A SYNTHESISED main lease is dropped, not projected. `synthesizeMainLease`
  // reports the pool's active account when the main thread holds no Codex lease
  // (every session whose main thread runs on Anthropic — `src/query.ts:324`
  // registers one only under `getAPIProvider() === 'openai'`), and it re-mints
  // `createdAt` on every snapshot. Projecting it put a row on screen claiming an
  // account the main thread was not using, with a held duration permanently
  // reading `0s`, and inflated every count derived from `owners`.
  if (mainLease && isProjectableLease(mainLease)) {
    owners.push(toOwnerRow(mainLease, aliases))
    seen.add(mainLease.ownerId)
  }

  for (const ownerId of liveWorkerOwnerIds(tasks)) {
    if (seen.has(ownerId)) continue
    const lease = reader.leaseForOwner(ownerId)
    // Guarded here too: only `synthesizeMainLease` mints a synthetic lease today,
    // but the drop is a property of the boundary, not of one call site.
    if (!lease || !isProjectableLease(lease)) continue
    owners.push(toOwnerRow(lease, aliases))
    seen.add(ownerId)
  }

  const accounts: LeaseAccountRow[] = engineSnapshot.accounts
    .filter(account => account.leaseCount > 0)
    .map(account => ({
      accountId: account.accountId,
      accountAlias: aliases.get(account.accountId) ?? null,
      leaseCount: account.leaseCount,
      holders: [...account.holders],
    }))

  return { strategy: engineSnapshot.strategy, owners, accounts }
}

/**
 * The lease owner ids of this session's live workers. A `local_agent` task's id IS
 * the `agentId` the Agent tool registered the lease under
 * (`createTaskStateBase(agentId, 'local_agent', …)`,
 * `src/tasks/LocalAgentTask/LocalAgentTask.tsx:618`;
 * `registerWorkerCodexLease({ ownerId: asyncAgentId, … })`,
 * `src/tools/AgentTool/AgentTool.tsx`), so no extra join field is needed. A
 * worker that is not on the Codex path registers none, which §Reactivity
 * above and the `!lease` skip in `leaseSnapshot` both already expect.
 */
function liveWorkerOwnerIds(
  tasks: Record<string, TaskState> | undefined,
): string[] {
  return Object.values(tasks ?? {})
    .filter(task => task.type === 'local_agent')
    .map(task => task.id)
}

/**
 * A lease that may cross the wire. The engine's `CodexLeaseSelectionKind` is a
 * SUPERSET of the protocol's: `synthetic` describes a row nothing actually leased,
 * so it has no wire representation and this guard is what keeps it that way. The
 * narrowing is the enforcement — `toOwnerRow` cannot be called on a synthetic
 * lease, rather than merely being expected not to be.
 */
type ProjectableLease = CodexLease & { selectionKind: LeaseSelectionKind }

function isProjectableLease(lease: CodexLease): lease is ProjectableLease {
  return !(NON_LEASE_SELECTION_KINDS as readonly string[]).includes(
    lease.selectionKind,
  )
}

function toOwnerRow(
  lease: ProjectableLease,
  aliases: Map<string, string | null>,
): LeaseOwnerRow {
  return {
    leaseId: lease.leaseId,
    ownerId: lease.ownerId,
    ownerType: lease.ownerType,
    ownerLabel: lease.ownerLabel,
    accountId: lease.accountId,
    accountAlias: aliases.get(lease.accountId) ?? null,
    strategy: lease.strategy,
    state: lease.state,
    createdAt: lease.createdAt,
    updatedAt: lease.updatedAt,
    failoverCount: lease.failoverCount,
    selectionKind: lease.selectionKind,
    // Resolved HERE because only this side can: `accountAliases()` reads the whole
    // pool, while the snapshot's `accounts` rollup carries only accounts currently
    // holding a lease — and the account an agent moved off has lost its own.
    // Omitted when the id is unknown to the pool (a deleted account), which is
    // exactly the case the renderer must not try to name.
    ...(lease.previousAccountId && aliases.has(lease.previousAccountId)
      ? {
        movedFrom: {
          accountId: lease.previousAccountId,
          accountAlias: aliases.get(lease.previousAccountId) ?? null,
        },
      }
      : {}),
    selectionReason: capReason(lease.selectionReason),
    ...(lease.lastFailureReason
      ? { lastFailureReason: capReason(lease.lastFailureReason) }
      : {}),
  }
}

function capReason(reason: string): string {
  return reason.length > MAX_REASON_CHARS
    ? reason.slice(0, MAX_REASON_CHARS)
    : reason
}
