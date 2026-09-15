/**
 * IDLE-PARK policy driver (decisions/IDLE-PARK.md §2/§4). Electron-free.
 *
 * N-process means every open tab holds a full engine process even when idle. This
 * driver is the policy OWNER main runs to reclaim those idle engines: it picks
 * victims and asks their sidecars to park (a gated, host-initiated `app.park`
 * frame). Only main sees every session and its recency, so the concurrent-count
 * CAP (the RAM lever) must live here; the sidecar owns the GATE (it alone knows
 * the true turn/permission/task state at the instant of park). A parked engine
 * self-exits with `PARKED_EXIT_CODE`; the host classifies the exit and the tab is
 * kept as a restore-on-click (§1) — none of that is this module's concern.
 *
 * Two triggers ship in v1 (both are tuning knobs below):
 *   - CAP (`MAX_LIVE_ENGINES`): keep at most N live engines; park the least-
 *     recently-active live sessions until at the cap. The safety valve under
 *     heavy tab stacking.
 *   - IDLE-TTL (`PARK_IDLE_TTL_MS`): park any live session idle beyond the TTL,
 *     even under the cap. At a typical 2–3 live sessions the cap never fires, so
 *     the TTL is the everyday reclaim.
 *
 * Both triggers skip the sessions the user can currently SEE (`protectedSessions`
 * — §4 open decision 4, resolved to option (b) on 2026-08-05): a pane on screen is
 * never reclaimed out from under its reader.
 *
 * A refused park is a silent no-op at the sidecar (the gate declined, or the
 * victim already exited → `supervisor.send` throws, caught here): the driver
 * simply re-evaluates on its next trigger.
 */

import type { SessionDescriptor } from '../shared/hostApi.js'

/* ------------------------------------------------------------------------- *
 * Tuning knobs (IDLE-PARK.md §4/§10.5). Adjust here.
 * ------------------------------------------------------------------------- */

/**
 * TUNING KNOB — max concurrent live engine processes before the soft-LRU cap
 * parks the least-recently-active ones. The safety valve, not the everyday
 * reclaim: at a typical 2–3 live sessions it never fires.
 */
export const MAX_LIVE_ENGINES = 4

/**
 * TUNING KNOB — a live session idle (no turn sent, no attach/spawn) for this long
 * is parked even under the cap, to reclaim genuinely-abandoned tabs. Generous so
 * a merely-quiet session is never reaped out from under a reader (restore is one
 * click away regardless).
 *
 * 20 min → 120 min on 2026-09-02. At 20 the TTL was shorter than the operator's
 * gap between visits to a session they multiplex, so it reclaimed sessions that
 * were merely quiet, which is the case this knob is meant to avoid: three days
 * of operational log hold 11 parks, ALL TTL-driven and none cap-driven, 6 of
 * them restored within the hour and 3 within 15 minutes, with the primary
 * session parked four times and restored after 4, 13, 35 and 38 minutes
 * (2026-09-02 assessment §5 item 3, §10.1). At 120 min every one of those
 * restores finds a live engine. The cost is bounded and small: an engine holds
 * about 223 MB, the cap holds live engines at MAX_LIVE_ENGINES, so the policy's
 * whole footprint is about 0.9 GB, and the five parks that were never restored
 * would hold their share up to two hours longer.
 */
export const PARK_IDLE_TTL_MS = 120 * 60 * 1000

/** How often the driver re-evaluates for the idle-TTL sweep. */
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000

/** A session with one of these statuses holds a live engine process. */
const LIVE_STATUSES: ReadonlySet<SessionDescriptor['status']> = new Set([
  'spawning',
  'ready',
])

export type IdleParkDriver = {
  /** Subscribe to host events (event-driven cap) + arm the idle-TTL sweep timer. */
  start(): void
  /** Stop the timer + unsubscribe; no further evaluations. */
  stop(): void
  /** Evaluate victims once now and park them (also the unit-test entry point). */
  evaluate(): void
}

export type IdleParkDriverDeps = {
  /** The host's live∪restorable view; the driver filters it to live engines. */
  listSessions: () => SessionDescriptor[]
  /**
   * IDLE-PARK §1c — a live session is eligible only if the host can resume it
   * after park. Main cannot derive this from a descriptor because live rows are
   * never restore candidates; the host checks the actual transcript and its
   * in-memory resume-failure verdict.
   */
  canResume: (appSessionId: SessionId) => boolean
  /**
   * IDLE-PARK §4 open decision 4, resolved 2026-08-05 as option (b): the sessions
   * the user is LOOKING AT are never park victims. Main cannot derive this — the
   * workspace layout is renderer-only state and merely switching panes bumps no
   * registry recency — so the renderer reports its visible pane ids over a fixed
   * one-way channel and main hands the validated set in here.
   *
   * Protection removes a session from the VICTIM POOL only; it stays counted as
   * live for the cap, so a protected session still pushes background sessions out
   * rather than raising the effective engine ceiling. Absent ⇒ nothing protected
   * (the pre-2026-08-05 behaviour, and what every unit test that omits it gets).
   */
  protectedSessions?: () => ReadonlySet<SessionId>
  /**
   * Park one session (main sends `app.park` via `supervisor.send`). May throw a
   * `SidecarSendError` if the victim is no longer `ready` (it raced to exit); the
   * driver catches that — a park refusal is expected, not an error.
   */
  park: (appSessionId: SessionId) => void
  /**
   * Subscribe to host events so the CAP re-evaluates on each session-added /
   * session-status (event-driven, no polling needed for the cap). The listener
   * takes no args — every host event just triggers a re-evaluation. Returns an
   * unsubscribe. Absent ⇒ the driver relies on the timer alone.
   */
  subscribeHostEvents?: (listener: () => void) => () => void
  maxLiveEngines?: number
  idleTtlMs?: number
  sweepIntervalMs?: number
  now?: () => number
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
  log?: (line: string) => void
}

type SessionId = SessionDescriptor['appSessionId']

const EMPTY_PROTECTED: ReadonlySet<SessionId> = new Set()

/**
 * recency = the MOST RECENT of the three stamps (IDLE-PARK.md §4).
 *
 * Deliberately a max, not the `lastMessageSentAt ?? lastAttachedAt ?? createdAt`
 * chain §4 originally specified: `??` is PRECEDENCE, not recency. It returns the
 * first non-null stamp, so any session that has ever run a turn is scored purely
 * on `lastMessageSentAt` and its `lastAttachedAt` is dead weight — which defeats
 * §4's own premise that "`lastAttachedAt` moves on attach/restore/spawn".
 *
 * A RESTORE is exactly where those two disagree. `registry.upsertOnSpawn` stamps
 * `lastAttachedAt = now` on the restored row (`app/host/registry.ts`) but
 * deliberately leaves `lastMessageSentAt` at whatever the session's last turn
 * wrote, possibly in a previous run days ago. Under `??` the driver read that
 * stale stamp, scored a session the user had just reopened as idle for the whole
 * gap, and parked it seconds after it went ready. The user sees a session stop on
 * its own; with nothing but `markMessageSent` able to refresh recency, and a turn
 * impossible to complete before the next sweep, Restart just re-entered the loop.
 * (2026-08-03: a row resumed 1 minute earlier carried an 18.6-hour-old
 * `lastMessageSentAt` against a 20-minute TTL, and reached `restartCount: 3`.)
 */
function recencyOf(session: SessionDescriptor): number {
  return Math.max(
    session.lastMessageSentAt ?? 0,
    session.lastAttachedAt,
    session.createdAt,
  )
}

export function createIdleParkDriver(deps: IdleParkDriverDeps): IdleParkDriver {
  const maxLiveEngines = deps.maxLiveEngines ?? MAX_LIVE_ENGINES
  const idleTtlMs = deps.idleTtlMs ?? PARK_IDLE_TTL_MS
  const sweepIntervalMs = deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS
  const now = deps.now ?? (() => Date.now())
  const canResume = deps.canResume
  const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
  const clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle))

  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let unsubscribe: (() => void) | null = null

  const selectVictims = (live: SessionDescriptor[]): Set<SessionId> => {
    const victims = new Set<SessionId>()
    // The user's visible panes are off the table for BOTH triggers. `live` keeps
    // them (they are real engine processes the cap must still count); only the
    // candidate pool below drops them, so an over-cap sweep parks the next
    // least-recent background session instead of the one being read.
    const protectedIds = deps.protectedSessions?.() ?? EMPTY_PROTECTED
    const candidates = live.filter(
      session =>
        !protectedIds.has(session.appSessionId) &&
        canResume(session.appSessionId),
    )
    // Idle-TTL: any live session idle beyond the TTL, regardless of the cap.
    const cutoff = now() - idleTtlMs
    for (const session of candidates) {
      if (recencyOf(session) <= cutoff) victims.add(session.appSessionId)
    }
    // Soft-LRU cap: when over the cap, park the least-recently-active live
    // sessions until at the cap. Least-recent first; the top-K recent are kept.
    if (live.length > maxLiveEngines) {
      const leastRecentFirst = [...candidates].sort(
        (a, b) => recencyOf(a) - recencyOf(b),
      )
      const overCount = live.length - maxLiveEngines
      for (let i = 0; i < overCount; i++) {
        const victim = leastRecentFirst[i]
        if (victim) victims.add(victim.appSessionId)
      }
    }
    return victims
  }

  const evaluate = (): void => {
    if (stopped) return
    const live = deps.listSessions().filter(s => LIVE_STATUSES.has(s.status))
    if (live.length === 0) return
    for (const appSessionId of selectVictims(live)) {
      try {
        deps.park(appSessionId)
      } catch (error) {
        // A refused park (victim no longer `ready`) is expected — re-evaluated on
        // the next trigger. Never let one non-ready victim abort the sweep.
        deps.log?.(
          `[idle-park] park ${appSessionId} skipped: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }
  }

  const scheduleSweep = (): void => {
    if (stopped) return
    timer = setTimer(() => {
      timer = null
      evaluate()
      scheduleSweep()
    }, sweepIntervalMs)
    timer.unref?.()
  }

  return {
    start() {
      if (stopped) return
      if (deps.subscribeHostEvents) {
        unsubscribe = deps.subscribeHostEvents(() => evaluate())
      }
      scheduleSweep()
    },
    stop() {
      stopped = true
      if (timer !== null) {
        clearTimer(timer)
        timer = null
      }
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
    },
    evaluate,
  }
}
