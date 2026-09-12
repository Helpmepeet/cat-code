/**
 * Codex lease state (P4-32b, L1, ruled 2026-07-30): the renderer half of the
 * read-only `lease.snapshot`
 * seam. Per-session snapshots plus read-time selectors; nothing is stored derived
 * and nothing is ever renderer-authored (there is no lease verb).
 *
 * The lease plane answers "which Codex account is each agent in THIS session's
 * swarm leasing right now", which is why it lives beside the worker roster rather
 * than on the global Accounts page.
 */
import type {
  AccountsSnapshot,
  AccountStatus,
  LiveWorkerItem,
  LeaseOwnerRow,
  LeaseSelectionKind,
  LeaseSnapshot,
  LeaseState,
  LeaseStrategy,
  ServerFrame,
  SessionId,
} from '../../shared/protocol.js'
import { createContext } from 'react'
import {
  selectActiveAccount,
  selectLastAccountsSnapshot,
  type AccountsState,
} from './accountsState.js'
import { selectWorkerDisplayName } from './workersState.js'

export type LeaseStateStore = {
  bySession: Record<SessionId, LeaseSnapshot | undefined>
  lastMainFailoverAccountIds: Record<SessionId, string | undefined>
}

export type LeaseAction =
  | { type: 'frame'; frame: ServerFrame }
  | { type: 'session-removed'; sessionId: SessionId }

export function createLeaseState(): LeaseStateStore {
  return { bySession: {}, lastMainFailoverAccountIds: {} }
}

export function reduceLeaseState(
  state: LeaseStateStore,
  action: LeaseAction,
): LeaseStateStore {
  if (action.type === 'session-removed') {
    if (
      !(action.sessionId in state.bySession) &&
      !(action.sessionId in state.lastMainFailoverAccountIds)
    ) {
      return state
    }
    const bySession = { ...state.bySession }
    const lastMainFailoverAccountIds = { ...state.lastMainFailoverAccountIds }
    delete bySession[action.sessionId]
    delete lastMainFailoverAccountIds[action.sessionId]
    return { ...state, bySession, lastMainFailoverAccountIds }
  }
  const { frame } = action

  if (frame.kind === 'lease.snapshot') {
    const mainLease = selectLeaseForOwner(frame.leases, MAIN_LEASE_OWNER_ID)
    const holdingMainLease =
      mainLease && LEASE_STATE_ROLE[mainLease.state] === 'holding' ? mainLease : null
    const previousFailoverAccountId = state.lastMainFailoverAccountIds[frame.sessionId]
    let lastMainFailoverAccountIds = state.lastMainFailoverAccountIds

    if (holdingMainLease?.selectionKind === 'failover') {
      lastMainFailoverAccountIds = {
        ...state.lastMainFailoverAccountIds,
        [frame.sessionId]: holdingMainLease.accountId,
      }
    } else if (
      previousFailoverAccountId &&
      holdingMainLease &&
      holdingMainLease.accountId !== previousFailoverAccountId
    ) {
      lastMainFailoverAccountIds = { ...state.lastMainFailoverAccountIds }
      delete lastMainFailoverAccountIds[frame.sessionId]
    }

    return {
      bySession: { ...state.bySession, [frame.sessionId]: frame.leases },
      lastMainFailoverAccountIds,
    }
  }

  if (
    frame.kind === 'account.result' &&
    frame.verb === 'account.switch' &&
    frame.ok &&
    frame.sessionId in state.lastMainFailoverAccountIds
  ) {
    const lastMainFailoverAccountIds = { ...state.lastMainFailoverAccountIds }
    delete lastMainFailoverAccountIds[frame.sessionId]
    return { ...state, lastMainFailoverAccountIds }
  }

  // A dead session's leases are gone with its engine process (the lease map is
  // per-process, in-memory) — drop the snapshot rather than show a stale one.
  if (frame.kind === 'lifecycle') {
    return {
      bySession: { ...state.bySession, [frame.sessionId]: undefined },
      lastMainFailoverAccountIds: state.lastMainFailoverAccountIds,
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

export function selectLastMainFailoverAccountId(
  state: LeaseStateStore,
  sessionId: SessionId | null,
): string | null {
  if (!sessionId) return null
  return state.lastMainFailoverAccountIds?.[sessionId] ?? null
}

/* ── read-time derivations ─────────────────────────────────────────────────── */

/**
 * The lease held by one owner, or null. `ownerId` is the subagent's `agentId`
 * (the roster's `LiveWorkerItem.agentId`) or `'main-thread'`; see the
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

/** The engine's owner id for the main lease (`src/query.ts`, protocol JOIN KEY note). */
const MAIN_LEASE_OWNER_ID = 'main-thread'

export type SessionCodexAccountSources = {
  /**
   * The roster the pane is already rendering — the host-global pool whenever one
   * exists (`composerRailModel.ts` `railAccounts`). It stays the source of every
   * displayed FIELD (usage, health, alias); only which row is active is resolved
   * here.
   */
  roster: AccountsSnapshot | null
  /** This session's own lease snapshot (`selectLeaseSnapshot`). */
  leases: LeaseSnapshot | null
  /** The last account reached by this session's successful main-thread failover. */
  lastMainFailoverAccountId?: string | null
  accounts: AccountsState
  sessionId: SessionId | null
}

/**
 * Which Codex account a session is actually ROUTING through, as a row of the
 * roster already on screen.
 *
 * The roster's own `isDefault` cannot answer this. It flags the PERSISTED active
 * account, read off disk by the disposable accounts-pool worker, while a session
 * is its own engine process holding its own in-memory `activeIndex`. Two ways
 * that drifts, both real:
 *  - another pane switches accounts, persisting B, and every pane's face starts
 *    saying B while this one still runs on C;
 *  - a failover moves a session's lease mid-turn. A MAIN-thread failover does
 *    converge on its own, because `withRetry` follows it with
 *    `persistMainLeaseActiveAccount` (`src/services/api/withRetry.ts:39,634`) and
 *    the pool catches up; but the global roster is republished by a worker on a
 *    60s timer, so until then the face still names the account the requests left.
 *    A SUBAGENT failover is not persisted at all — only main is.
 *
 * Order, freshest identity first:
 *  1. this session's ACTIVE main-thread lease — the routing identity of a live
 *     turn. A failed lease keeps the account id it could NOT use, so only a
 *     holding one names an account (the `selectLeaseForLabel` refusal, reused).
 *  2. this session's last successful main-thread failover, retained after the
 *     per-turn lease release because that release does not refresh accounts.
 *  3. this session's OWN accounts snapshot, built from its in-memory pool —
 *     `selectLastAccountsSnapshot`, so a parked or crashed session keeps naming
 *     what it actually ran on instead of falling back to a persisted account it
 *     never used. That selector exists for this face and is display-only; the
 *     switcher's arming is decided separately by `canSwitchAccount`.
 *  4. the roster's persisted active account, i.e. the previous behaviour.
 *
 * Between turns there is legitimately no main lease: the engine registers it per
 * turn and releases it in a `finally`, and the sidecar drops synthesised leases.
 * So step 1 coming up empty is the ORDINARY case and step 2 carries it.
 *
 * An id the roster does not contain falls through to the next step rather than
 * rendering an invented or empty row: a wrong account is worse than a stale one.
 */
export function selectSessionCodexAccount(
  sources: SessionCodexAccountSources,
): AccountStatus | null {
  const { accounts, lastMainFailoverAccountId, leases, roster, sessionId } = sources
  const rows = roster?.accounts ?? []
  const rosterRow = (accountId: string): AccountStatus | null =>
    rows.find(row => row.id === accountId) ?? null

  const mainLease = selectLeaseForOwner(leases, MAIN_LEASE_OWNER_ID)
  if (mainLease && LEASE_STATE_ROLE[mainLease.state] === 'holding') {
    const leased = rosterRow(mainLease.accountId)
    if (leased) return leased
  }

  if (lastMainFailoverAccountId) {
    const failedOver = rosterRow(lastMainFailoverAccountId)
    if (failedOver) return failedOver
  }

  const own = selectActiveAccount(selectLastAccountsSnapshot(accounts, sessionId))
  if (own) {
    const owned = rosterRow(own.id)
    if (owned) return owned
  }

  return selectActiveAccount(roster)
}

/**
 * The lease held by the worker a transcript row describes, matched on the label
 * both planes already carry.
 *
 * `registerWorkerCodexLease` stamps `ownerLabel` with the Agent tool's own
 * `description` argument (`src/tools/AgentTool/AgentTool.tsx:1502`), which is
 * required (`:520`) and is the same string the card reads as `input.description`.
 * The wire contract says so directly: `LeaseOwnerRow.ownerLabel` is documented as
 * "the delegated task description".
 *
 * This is the only key alive WHILE a foreground worker runs. Its `agentId`
 * reaches the transcript with the RESULT, so `selectLeaseForOwner` cannot answer
 * until the run is already over. The stamp design proved those two windows
 * disjoint and concluded the gap could not be closed
 * (`docs/plans/2026-08-21-subagent-account-transcript-stamp-design.md` §1); that
 * held for `agentId` and not for the problem, which this key closes with no new
 * field on either plane.
 *
 * TWO deliberate refusals, because a wrong account is worse than no account and
 * the card already renders null as silence:
 *
 *  - **Ambiguity.** A description is 3-5 words and is not unique, so two
 *    concurrent workers can share one. More than one match returns null rather
 *    than picking the first.
 *  - **Non-holding leases.** A failed lease keeps the account id it could NOT
 *    use (`codexAccountLeaseManager.ts:356-362`) — the same trap
 *    `selectLeaseGroups` avoids by filing it under the stranded bucket instead of
 *    a healthy-looking account. Only an active lease names an account here.
 */
export function selectLeaseForLabel(
  snapshot: LeaseSnapshot | null,
  label: string | null,
): LeaseOwnerRow | null {
  if (!snapshot || !label) return null
  let found: LeaseOwnerRow | null = null
  for (const owner of snapshot.owners) {
    if (owner.ownerType !== 'subagent') continue
    if (owner.ownerLabel !== label) continue
    if (LEASE_STATE_ROLE[owner.state] !== 'holding') continue
    if (found !== null) return null
    found = owner
  }
  return found
}

/**
 * The tab's count chip. Deliberately every owner row, not just the active ones:
 * it has to equal the sum of the group counts the panel prints, and an agent that
 * failed to get an account still occupies a row. The engine's own per-account
 * rollup (`LeaseSnapshot.accounts`) is NOT the source here — it omits a
 * synthesised main lease (`codexAccountLeaseManager.ts:168-170,438`), which is why
 * the tab, the rollup and the owner list used to print three different numbers.
 */
export function selectLeaseAgentCount(snapshot: LeaseSnapshot | null): number {
  if (!snapshot) return 0
  return snapshot.owners.filter(owner => LEASE_STATE_ROLE[owner.state] !== 'gone')
    .length
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

/**
 * The account as a SHORT label: the pool's redacted alias, else the first few
 * characters of its identifier. An un-aliased account is the ordinary case (the
 * alias is set only by an explicit rename), and a full UUID does not belong in a
 * transcript card or a panel heading. Two un-aliased accounts still read as
 * different, which `'Unnamed account'` would not give.
 */
export function leaseAccountShortLabel(row: {
  accountId: string
  accountAlias: string | null
}): string {
  return row.accountAlias ?? row.accountId.slice(0, ACCOUNT_ID_PREVIEW_CHARS)
}

/** The account's display label: the pool's redacted alias, else its identifier. */
export function leaseAccountLabel(row: {
  accountId: string
  accountAlias: string | null
}): string {
  return row.accountAlias ?? row.accountId
}

/* ── the panel's own shape: accounts, each holding its agents ──────────────── */

/**
 * A humanised replacement for the engine's `selectionReason`, which is a log
 * string and not display text: it embeds raw account UUIDs twice over
 * (`failover from <uuid>: Codex account <uuid> …`,
 * `codexAccountLeaseManager.ts:333`) and otherwise reads as internal vocabulary
 * ("spread selected least crowded healthy account", `:551`). The engine's own
 * text survives as `detail`, which the panel surfaces only on hover.
 *
 * The account an agent moved FROM is named when `movedFrom` carries an alias. It
 * cannot be derived here: that account has lost its lease, so it is absent from
 * `LeaseSnapshot.accounts`, and only the sidecar can see the whole pool. When the
 * sidecar could not resolve it either (a deleted account), the wording stays
 * anonymous rather than inventing a name.
 */
export type LeaseAgentNote = {
  text: string
  tone: 'moved' | 'stranded'
  /** The engine's raw reason, for a title attribute. Never rendered as body text. */
  detail: string
}

/** One agent, as it appears under its account. */
export type LeaseAgentRow = {
  ownerId: string
  /**
   * The worker's minted handle (`workerNames.ts` pools, surfaced by
   * `selectWorkerDisplayName`), or null when it has none and the row leads with
   * its task text instead.
   */
  name: string | null
  /** Delegated task text. Null for the main thread, which has no task. */
  task: string | null
  isMain: boolean
  /** Held duration, for an active lease only. */
  held: string | null
  note: LeaseAgentNote | null
}

/** One account and the agents on it. */
export type LeaseAccountGroup = {
  key: string
  label: string
  /** The bucket for agents holding no usable account, which leads the list. */
  isStranded: boolean
  agents: LeaseAgentRow[]
}

/** Safe as a map key beside real account ids: those are UUIDs, which cannot equal this. */
const STRANDED_KEY = 'no-account'
const STRANDED_LABEL = 'No account'
const NOTE_STRANDED = 'every account was capped or unavailable'
const NOTE_MOVED = 'moved here from another account'
const NOTE_REPAIRED = 'moved here, its account could not be used'

/**
 * The note text for a lease that moved. Names the account it came from when the
 * sidecar could resolve one; falls back to the anonymous wording when it could
 * not, which happens when that account has since been deleted from the pool.
 */
function movedNoteText(owner: LeaseOwnerRow): string {
  const from = owner.movedFrom
  const name = from?.accountAlias ?? null
  if (!name) {
    return owner.selectionKind === 'repaired' ? NOTE_REPAIRED : NOTE_MOVED
  }
  return owner.selectionKind === 'repaired'
    ? `moved here, ${name} could not be used`
    : `moved here from ${name}`
}
/** `claude.ts:1177` labels a lease `Subagent <agentId>`; that id is not display text. */
const OWNER_LABEL_ID_PREFIX = 'Subagent '
const UNNAMED = 'Unnamed worker'
/**
 * The main thread's name is renderer-owned, never the engine's `ownerLabel`: the
 * two engine paths disagree on casing (`'Main thread'`, `src/query.ts:328`, vs
 * `'main thread'` on the synthesised lease, `codexAccountLeaseManager.ts:432`), so
 * reading it would let an internal code path decide how a heading-weight name looks.
 */
const MAIN_THREAD_NAME = 'Main thread'
/** How much of an account id to show when the pool has no alias for it (see `leaseGroupLabel`). */
const ACCOUNT_ID_PREVIEW_CHARS = 8

/**
 * What a lease state means for this panel. Exhaustive by construction: extend
 * `LeaseState` and this stops compiling, which is the tripwire a closed union is
 * required to carry.
 */
type LeaseRole = 'holding' | 'stranded' | 'gone'
const LEASE_STATE_ROLE: Record<LeaseState, LeaseRole> = {
  active: 'holding',
  failed: 'stranded',
  // Unreachable today: `releaseCodexLease` DELETES the map entry rather than
  // marking it (`codexAccountLeaseManager.ts:294-296`). Mapped rather than
  // assumed away, and a lease that holds nothing has no row to render.
  released: 'gone',
}

/** Strips account UUIDs out of engine text bound for a `title`, itself a §7 text surface. */
const ACCOUNT_ID_PATTERN =
  /\s*\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi

function redactAccountIds(reason: string): string {
  return reason.replace(ACCOUNT_ID_PATTERN, '').replace(/\s+/g, ' ').trim()
}

/**
 * Which selection kinds are worth telling the user about. `manual` is the user's
 * own `/switch-account`, so saying it back is the noise the operator rules forbid;
 * `initial` is the ordinary case. Exhaustive, so a new engine kind must be
 * classified here rather than silently falling through as unremarkable.
 */
const SELECTION_KIND_IS_NEWS: Record<LeaseSelectionKind, boolean> = {
  initial: false,
  manual: false,
  failover: true,
  repaired: true,
}

function leaseAgentNote(owner: LeaseOwnerRow): LeaseAgentNote | null {
  const detail = redactAccountIds(owner.lastFailureReason ?? owner.selectionReason)
  if (LEASE_STATE_ROLE[owner.state] === 'stranded') {
    return { text: NOTE_STRANDED, tone: 'stranded', detail }
  }
  if (SELECTION_KIND_IS_NEWS[owner.selectionKind]) {
    return { text: movedNoteText(owner), tone: 'moved', detail }
  }
  return null
}

/**
 * A group's heading. Falls back to a SHORT id rather than the whole one: an
 * un-aliased account is the ordinary case (the pool's `alias` is optional and set
 * only by an explicit rename), and this heading is the panel's most prominent text.
 * Two un-aliased accounts still read as different groups, which `'Unnamed account'`
 * would not give.
 */
function leaseGroupLabel(owner: LeaseOwnerRow): string {
  return leaseAccountShortLabel(owner)
}

function toLeaseAgentRow(
  owner: LeaseOwnerRow,
  workersById: ReadonlyMap<string, LiveWorkerItem>,
  nowMs: number,
): LeaseAgentRow {
  const isMain = owner.ownerType === 'main'
  const worker = workersById.get(owner.ownerId)
  const handle = worker ? selectWorkerDisplayName(worker) : null
  const ownerLabel = owner.ownerLabel.startsWith(OWNER_LABEL_ID_PREFIX)
    ? null
    : owner.ownerLabel
  // `||` throughout, not `??`: an empty engine string is as absent as a missing
  // one, and letting it through renders a row with no identity at all.
  const task = isMain ? null : worker?.description?.trim() || ownerLabel || null
  const name = isMain ? MAIN_THREAD_NAME : handle

  return {
    ownerId: owner.ownerId,
    name: name || (task ? null : UNNAMED),
    task,
    isMain,
    held:
      LEASE_STATE_ROLE[owner.state] === 'holding'
        ? leaseHeldLabel(owner.createdAt, nowMs)
        : null,
    note: leaseAgentNote(owner),
  }
}

/**
 * The panel's rows: one group per account, in first-appearance order (which puts
 * the main thread's account first), with the stranded bucket pulled to the top.
 * Grouping is derived from `owners`, never from the engine's `accounts` rollup —
 * see `selectLeaseAgentCount` for why those two disagree.
 */
export function selectLeaseGroups(
  snapshot: LeaseSnapshot | null,
  workers: readonly LiveWorkerItem[],
  nowMs: number,
): LeaseAccountGroup[] {
  if (!snapshot) return []

  const workersById = new Map(workers.map(worker => [worker.agentId, worker]))
  const byKey = new Map<string, LeaseAccountGroup>()
  for (const owner of snapshot.owners) {
    const role = LEASE_STATE_ROLE[owner.state]
    if (role === 'gone') continue
    // A failed lease keeps the account id it could not use
    // (`codexAccountLeaseManager.ts:356-362`), so grouping it by that id would
    // file a stranded agent under a healthy-looking account.
    const isStranded = role === 'stranded'
    const key = isStranded ? STRANDED_KEY : owner.accountId
    let group = byKey.get(key)
    if (!group) {
      group = {
        key,
        label: isStranded ? STRANDED_LABEL : leaseGroupLabel(owner),
        isStranded,
        agents: [],
      }
      byKey.set(key, group)
    }
    group.agents.push(toLeaseAgentRow(owner, workersById, nowMs))
  }

  const groups = [...byKey.values()]
  return [
    ...groups.filter(group => group.isStranded),
    ...groups.filter(group => !group.isStranded),
  ]
}

/**
 * The one line worth printing above the groups, or null. A `spread` session that
 * put every agent on a single account has silently lost its spread, which the
 * grouped list alone does not say out loud. Everything else about the state the
 * user already chose is left unsaid (the `settingsRowNote` rule).
 */
export function selectLeaseConcentrationNote(
  strategy: LeaseStrategy | null,
  groups: readonly LeaseAccountGroup[],
): string | null {
  if (strategy !== 'spread') return null
  // Every group, not just the held ones: with an agent stranded alongside, "All N
  // agents" would contradict the tab count printed on the same screen.
  if (groups.length !== 1) return null
  const only = groups[0]
  if (!only || only.isStranded || only.agents.length < 2) return null
  return `All ${only.agents.length} agents landed on one account.`
}

/**
 * The session's lease snapshot, handed down so a transcript row can name the
 * account its worker is holding. Null outside a session, and null on every
 * Anthropic-path session — the lease plane is Codex-only.
 *
 * This is a LIVE overlay, not a transcript fact: the lease map is per-process and
 * in-memory, so a restored transcript shows no account on rows whose worker died
 * with its engine. That is the same policy `reduceLeaseState` already applies on
 * `lifecycle` (drop the snapshot rather than show a stale one), and it is why the
 * account is rendered only when present rather than as a slot that can go blank.
 */
export const LeaseSnapshotContext = createContext<LeaseSnapshot | null>(null)
