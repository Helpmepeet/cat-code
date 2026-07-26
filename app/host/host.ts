/**
 * The host composition layer (D1 — `decisions/REGISTRY.md` §6/§6.1; trust zone —
 * `decisions/SECURITY-MINIMUM.md` Addendum, T8 / HC1–HC4).
 *
 * This is the "design the control plane once" deliverable executed as code. It
 * wires three Electron-FREE modules into the typed host API (`HostApi`):
 *   - the supervisor (`app/supervisor/supervisor.ts`) — the in-memory process
 *     manager (spawn/kill/restart/listSessions/events);
 *   - the registry (`app/host/registry.ts`, P3-2) — the durable app-owned index;
 *   - per-session spawn config (P3-1) — cwd + resumeEngineSessionId to the sidecar.
 *
 * It owns NO `electron` import: Electron main is a CALLER (single-instance lock,
 * native dir picker, replay eviction all live in main); a v2 daemon would call
 * this same interface. The control plane never adds a socket frame type — its
 * only contact with a sidecar is the spawn environment (main-owned input, HC1),
 * exactly as the addendum requires.
 *
 * Failure model (REGISTRY.md §6.1): every method returns a typed `HostResult`;
 * a failure is a `HostError` value the caller pattern-matches, NEVER a bare
 * thrown string that leaks internal state across the boundary (HC2). A registry
 * write failure DEGRADES persistence (`registry_unavailable`) but never kills a
 * live session.
 */

import { randomUUID } from 'node:crypto'

import type { SessionRegistry, RegistrySession } from './registry.js'
import type {
  SidecarStatus,
  SidecarSupervisor,
  SupervisorEvent,
} from '../supervisor/supervisor.js'
import type { SessionId } from '../shared/protocol.js'
import { PARKED_EXIT_CODE } from '../shared/limits.js'
import {
  MAX_LIVE_SESSIONS,
  MAX_SESSION_TITLE_CHARS,
  MAX_SPAWNS_PER_WINDOW,
  SPAWN_RATE_WINDOW_MS,
  type CreateSessionRequest,
  type HostApi,
  type HostError,
  type HostErrorCode,
  type HostEvent,
  type HostResult,
  type SessionDescriptor,
} from '../shared/hostApi.js'

/* ------------------------------------------------------------------------- *
 * Injected dependencies (main provides the electron-bound / real-fs ones; tests
 * pass hermetic fakes so this module runs without electron and without a real
 * process tree).
 * ------------------------------------------------------------------------- */

export type CwdValidation = { ok: true; realpath: string } | { ok: false }

export type HostOptions = {
  supervisor: SidecarSupervisor
  registry: SessionRegistry
  /**
   * HC1 — canonicalize + existence/isDirectory check a cwd, regardless of
   * origin. Main injects the real `realpathSync` + `statSync().isDirectory()`;
   * tests inject a controllable check. Returns the canonical path on success so
   * the row and the spawn both use the SAME resolved path (no symlink skew).
   */
  validateCwd: (cwd: string) => CwdValidation
  /**
   * Called when a session is closed/restarted so main can evict its replay
   * buffer (the P3-0 carry — `AttachmentGate.clearSession`). Kept as an injected
   * callback so this module stays Electron-free (the gate lives in main).
   */
  evictReplay?: (appSessionId: SessionId) => void
  /** Structured logger. Defaults to stderr. */
  log?: (line: string) => void
  /** Clock (spawn rate window). Injected for deterministic HC4 tests. */
  now?: () => number
  /**
   * The registry launch sequence (read → sweep orphans → reap). Every mutating
   * host op AWAITS this before touching the registry, so the launch's own
   * read-modify-write is never interleaved with a concurrent spawn's write
   * (REGISTRY.md §4: "before any spawn"). When omitted (tests that don't exercise
   * launch ordering), the gate is already-resolved.
   */
  launched?: Promise<unknown>
}

/* UUID v1–v5 shape — the HC2 membership pre-check (cheap reject of garbage ids
 * before any map/registry lookup). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

function hostError(code: HostErrorCode, message: string): { ok: false; error: HostError } {
  return { ok: false, error: { code, message } }
}

export class Host implements HostApi {
  private readonly supervisor: SidecarSupervisor
  private readonly registry: SessionRegistry
  private readonly validateCwd: (cwd: string) => CwdValidation
  private readonly evictReplay: (appSessionId: SessionId) => void
  private readonly log: (line: string) => void
  private readonly now: () => number

  private readonly listeners = new Set<(event: HostEvent) => void>()

  /** Spawn-rate ring (HC4): timestamps of recent createSession spawns. */
  private spawnTimes: number[] = []

  /**
   * appSessionIds currently gracefully closing (or having a crash tombstone
   * cleared for restore). NOTE the real supervisor emits NO exit event after
   * `killSession` — it deregisters first, and the F11 identity guard drops the
   * child's late exit (supervisor.ts:262 after registry.delete) — so in
   * production this set suppresses nothing today. It is defense-in-depth for
   * any future exit path that fires during a close, and it suppresses the
   * synthetic exit the test FakeSupervisor's killSession emits; without it a
   * host-asked kill could be mis-marked as a crash (F3).
   */
  private readonly closing = new Set<SessionId>()

  /** Resolves once the registry launch sweep has completed (B4 / REGISTRY §4). */
  private readonly launched: Promise<unknown>

  constructor(options: HostOptions) {
    this.supervisor = options.supervisor
    this.registry = options.registry
    this.validateCwd = options.validateCwd
    this.evictReplay = options.evictReplay ?? (() => {})
    this.log = options.log ?? (line => process.stderr.write(`${line}\n`))
    this.now = options.now ?? Date.now
    // Never reject the gate — a failed launch already logged and started empty;
    // ops proceed against the in-memory doc (the registry is an index, not a
    // backup). We only need the sweep's read-modify-write to have SETTLED first.
    this.launched = (options.launched ?? Promise.resolve()).catch(() => undefined)
    this.wireSupervisor()
  }

  /* --------------------------------------------------------------------- *
   * Supervisor event → registry row updates + HostEvent stream
   * --------------------------------------------------------------------- */

  private wireSupervisor(): void {
    this.supervisor.subscribe(event => {
      void this.onSupervisorEvent(event)
    })
  }

  private async onSupervisorEvent(event: SupervisorEvent): Promise<void> {
    const appSessionId = event.sessionId

    if (event.type === 'frame') {
      // Relay the ready frame's engineSessionId into the registry row (the
      // two-id bridge, REGISTRY.md §2). Only the ready frame carries it.
      if (event.frame.kind === 'ready') {
        await this.registry.fillEngineSessionId(
          appSessionId,
          event.frame.engineSessionId,
        )
        this.emitStatus(appSessionId)
      } else if (event.frame.kind === 'event') {
        // CC-2 (app/renderer/src/sidebarState.ts deferred spec): the sidebar row
        // time must track a real message SENT this run, not an attach/open. A
        // `replay:true` EventFrame is history the resumed sidecar re-emits at
        // OPEN/restore (protocol.ts EventFrame.replay) — it must NEVER bump the
        // recency. Among live frames, a `result` message is the once-per-turn
        // turn-end signal: it fires exactly once after a user turn actually runs
        // and, being a `type:'result'` SDKMessage, can never be a tool_result
        // echo (those ride `type:'user'` frames). Non-`event` snapshot frames
        // (ready/settings/accounts/goal/…) never enter this branch at all.
        const { frame } = event
        if (
          !frame.replay &&
          frame.event.type === 'message' &&
          frame.event.message.type === 'result'
        ) {
          await this.registry.markMessageSent(appSessionId)
          this.emitStatus(appSessionId)
        }
      }
      return
    }

    if (event.type === 'exit') {
      // A graceful close already marked the row clean + emitted removed; don't
      // re-report the async exit that killSession triggers.
      if (!this.closing.has(appSessionId)) {
        // IDLE-PARK (decisions/IDLE-PARK.md §2) — the exit CODE is the truth
        // signal. A `PARKED_EXIT_CODE` self-exit is a park, not a crash: mark it
        // `'parked'` so the descriptor stays disconnected+restorable (tab kept)
        // WITHOUT the terminal-reap dropping it. Any other exit the host did not
        // ask for IS the crash (F3), and this event is the only moment the host
        // knows it. Both `markParked`/`markCrashed` only transition LIVE rows, so
        // the shutdownAll mark-clean-then-kill ordering is unaffected.
        if (event.code === PARKED_EXIT_CODE) {
          await this.registry.markParked(appSessionId)
        } else {
          await this.registry.markCrashed(appSessionId)
        }
        this.emitStatus(appSessionId)
      }
      return
    }

    // status change. `failed` (spawn error / invalid ready) is a death with no
    // exit event behind it in the spawn-error case — same F3 treatment.
    if (event.status === 'failed' && !this.closing.has(appSessionId)) {
      await this.registry.markCrashed(appSessionId)
    }
    this.emitStatus(appSessionId)
  }

  /* --------------------------------------------------------------------- *
   * createSession (HC1 cwd revalidate · HC4 caps · spawn_failed)
   * --------------------------------------------------------------------- */

  async createSession(
    req: CreateSessionRequest,
  ): Promise<HostResult<SessionDescriptor>> {
    // B4 — the registry launch sweep must complete before any spawn writes a row.
    await this.launched
    // HC1 — the host re-validates the cwd regardless of origin. The renderer
    // CANNOT author a path: main resolves a native-picker TOKEN to the realpath
    // before this is called (`req.cwd` is main-supplied, never a renderer string).
    // `req.resumeEngineSessionId` is set by `restoreSession` from a registry row
    // and by main's open-from-history path, which resolves BOTH the id and the
    // cwd from the sidecar-written catalog cache (SESSIONS-UNIFICATION) — still
    // never a renderer-authored value. Note a create can therefore RESUME: main
    // arms replay coalescing for that case so `ready` cannot outrun the history
    // replay. This canonicalize + existence check is the defense-in-depth backstop.
    if (typeof req?.cwd !== 'string' || req.cwd.length === 0) {
      return hostError('invalid_cwd', 'cwd must be a non-empty string')
    }
    const validated = this.validateCwd(req.cwd)
    if (!validated.ok) {
      return hostError(
        'invalid_cwd',
        `cwd is not an existing directory: ${req.cwd}`,
      )
    }
    const cwd = validated.realpath

    // HC4 — bound row count AND spawn rate; either breach → session_limit.
    const limit = this.checkSpawnLimits()
    if (limit) return limit

    return this.spawn({
      appSessionId: randomUUID(),
      cwd,
      title: capTitle(req.title),
      resumeEngineSessionId: req.resumeEngineSessionId,
    })
  }

  /* --------------------------------------------------------------------- *
   * restoreSession — sugar over create with the row's cwd + engineSessionId
   * --------------------------------------------------------------------- */

  async restoreSession(
    appSessionId: SessionId,
  ): Promise<HostResult<SessionDescriptor>> {
    await this.launched
    // HC2 — validate id shape before any lookup; unknown → session_not_found.
    if (!isUuid(appSessionId)) {
      return hostError('session_not_found', 'malformed session id')
    }
    const row = this.registry.findSession(appSessionId)
    // §9-A4: fails session_not_found if the row OR its transcript is gone. The
    // registry only offers restorable rows whose transcript exists (launch reap),
    // and a null engineSessionId row is not resumable.
    if (!row || row.engineSessionId === null) {
      return hostError(
        'session_not_found',
        `no restorable session ${appSessionId}`,
      )
    }
    // §9-A4 (SF6) — re-check transcript existence NOW, not just at launch: it may
    // have been pruned between launch and this restore. Never offer a restore we
    // cannot perform (which would exit `resume-failed` downstream).
    if (!this.registry.hasTranscript(appSessionId)) {
      return hostError(
        'session_not_found',
        `transcript for ${appSessionId} is gone`,
      )
    }
    if (this.registry.hasLiveAdvisorySidecar(appSessionId)) {
      return hostError(
        'session_not_found',
        `prior sidecar for ${appSessionId} is still running`,
      )
    }
    // Only a genuinely running process refuses a restore. A terminal supervisor
    // record ('exited'/'failed') is a dead sidecar's tombstone — kept so the
    // tab's restart-in-place works — and is exactly the crashed restore-offer
    // case: deregister it below so the re-spawn can reuse the appSessionId
    // (spawnSession rejects a duplicate id).
    const record = this.supervisor
      .listSessions()
      .find(s => s.sessionId === appSessionId)
    if (record && !isTerminalStatus(record.status)) {
      return hostError(
        'session_not_found',
        `session ${appSessionId} is already live`,
      )
    }

    // Re-validate the row's cwd too (HC1 defense in depth: a row can go stale if
    // its directory was moved/deleted between launches).
    const validated = this.validateCwd(row.cwd)
    if (!validated.ok) {
      return hostError('invalid_cwd', `session cwd no longer exists: ${row.cwd}`)
    }

    const limit = this.checkSpawnLimits()
    if (limit) return limit

    // Clear the crashed tombstone (guarded by `closing` so the fake/late exit
    // the kill fires is not re-reported as a fresh crash — same suppression as
    // closeSession; the child is already dead, so this only deregisters).
    if (record) {
      this.closing.add(appSessionId)
      this.supervisor.killSession(appSessionId)
      this.closing.delete(appSessionId)
    }

    return this.spawn({
      appSessionId,
      cwd: validated.realpath,
      title: row.title,
      resumeEngineSessionId: row.engineSessionId,
    })
  }

  /* --------------------------------------------------------------------- *
   * createSessionInWorkspace — a FRESH session in an existing workspace (#15).
   * The per-workspace "+" names a REGISTRY id (a representative session already
   * rooted at the target cwd); the host re-derives + re-validates that row's cwd
   * from its OWN registry (HC1/T8 — the renderer authors NO path), exactly as
   * `restoreSession` sources a cwd. Unlike restore this mints a NEW appSessionId
   * with NO resume (a blank engine context), so it needs neither a transcript nor
   * an engineSessionId on the row.
   * --------------------------------------------------------------------- */

  async createSessionInWorkspace(
    appSessionId: SessionId,
  ): Promise<HostResult<SessionDescriptor>> {
    await this.launched
    // HC2 — validate id shape before any lookup; unknown → session_not_found. A
    // renderer-supplied raw path is not a UUID and is rejected HERE, so the
    // renderer is structurally unable to author a cwd through this method.
    if (!isUuid(appSessionId)) {
      return hostError('session_not_found', 'malformed session id')
    }
    const row = this.registry.findSession(appSessionId)
    if (!row) {
      return hostError(
        'session_not_found',
        `no workspace for session ${appSessionId}`,
      )
    }
    // HC1 — re-derive + re-validate the cwd from the host's own row (never a
    // renderer string, never a stale value: a row can go stale if its directory
    // was moved/deleted between launches). This is the load-bearing trust point.
    const validated = this.validateCwd(row.cwd)
    if (!validated.ok) {
      return hostError('invalid_cwd', `workspace cwd no longer exists: ${row.cwd}`)
    }

    const limit = this.checkSpawnLimits()
    if (limit) return limit

    // FRESH session in that workspace: a NEW appSessionId + NO
    // resumeEngineSessionId (this is a new session, not a restore of the named one).
    return this.spawn({
      appSessionId: randomUUID(),
      cwd: validated.realpath,
      title: undefined,
      resumeEngineSessionId: undefined,
    })
  }

  /* --------------------------------------------------------------------- *
   * Shared spawn path (create + restore) — upsert row, spawn sidecar, record
   * advisory fields, emit session-added.
   * --------------------------------------------------------------------- */

  private async spawn(input: {
    appSessionId: SessionId
    cwd: string
    title: string | null | undefined
    resumeEngineSessionId: string | undefined
  }): Promise<HostResult<SessionDescriptor>> {
    const { appSessionId, cwd, resumeEngineSessionId } = input
    const title = input.title ?? undefined
    this.recordSpawnTime()

    // Persist the live row BEFORE spawning so a crash between spawn and the next
    // launch still finds a row to sweep (REGISTRY.md §4.5 write points). The
    // upsert may reap terminal rows to stay under the bound — surface those as
    // session-removed so a subscriber's projection drops them (F5).
    const reaped = await this.registry.upsertOnSpawn({ appSessionId, cwd, title })
    for (const reapedId of reaped) {
      this.emitRemoved(reapedId)
    }

    try {
      this.supervisor.spawnSession(appSessionId, {
        cwd,
        ...(resumeEngineSessionId !== undefined ? { resumeEngineSessionId } : {}),
      })
    } catch (error) {
      // Spawn threw synchronously (e.g. socket-path overflow, duplicate id). The
      // row we just wrote is now dead — mark it clean so it does not masquerade
      // as a live crash on the next sweep, and report spawn_failed. A fresh
      // create's row (engineSessionId null) is neither a tab nor an offer —
      // remove it; a RESTORE's row still holds its engineSessionId and remains
      // a valid restore-offer — a session-removed would hide it until relaunch
      // (the renderer pins removed ids), so re-emit its (exited, restorable)
      // status instead (SF-2, P3-5 review).
      await this.registry.markClean(appSessionId)
      const row = this.registry.findSession(appSessionId)
      if (row && row.engineSessionId !== null) {
        this.emitStatus(appSessionId)
      } else {
        this.emitRemoved(appSessionId)
      }
      return hostError(
        'spawn_failed',
        `could not spawn session: ${errText(error)}`,
      )
    }

    // Record the advisory runtime fields now that the child exists (§9-A3 orphan
    // identity + crash sweep). Advisory-only refresh (F4: a second upsert here
    // double-bumped restartCount). Persistence failure degrades but never fails.
    await this.registry.setAdvisoryRuntime(appSessionId, {
      enginePid: this.supervisor.getSessionProcessId(appSessionId),
      socketPath: this.supervisor.getSessionSocketPath(appSessionId),
    })
    this.surfaceRegistryHealth(appSessionId)

    const descriptor = this.descriptorFor(appSessionId)
    if (!descriptor) {
      // Unreachable in practice (we just upserted the row) — typed, not thrown.
      return hostError('spawn_failed', 'session vanished immediately after spawn')
    }
    this.emit({ type: 'session-added', session: descriptor })
    return { ok: true, value: descriptor }
  }

  /* --------------------------------------------------------------------- *
   * closeSession — graceful shutdown; row kept restorable + marked clean; MUST
   * evict replay state (the P3-0 carry).
   * --------------------------------------------------------------------- */

  async closeSession(appSessionId: SessionId): Promise<HostResult<void>> {
    await this.launched
    if (!isUuid(appSessionId)) {
      return hostError('session_not_found', 'malformed session id')
    }
    if (!this.isLive(appSessionId) && !this.registry.findSession(appSessionId)) {
      return hostError('session_not_found', `unknown session ${appSessionId}`)
    }

    this.closing.add(appSessionId)
    // Graceful sidecar shutdown (SIGTERM via the supervisor's kill API — the
    // die-with-window mechanism, not process welding).
    this.supervisor.killSession(appSessionId)
    // Evict replay so a reload never replays a dead session's frames (P3-0 carry
    // — the named eviction requirement; AttachmentGate.clearSession in main).
    this.evictReplay(appSessionId)
    // Row is KEPT (restorable): mark clean, clear advisory runtime fields.
    await this.registry.markClean(appSessionId)
    this.surfaceRegistryHealth(appSessionId)
    this.closing.delete(appSessionId)

    const row = this.registry.findSession(appSessionId)
    if (row?.engineSessionId === null) {
      this.emitRemoved(appSessionId)
    } else {
      // The row still exists (restorable) but is no longer live — the session left
      // the "live" half of the union, so the list projection must drop the live
      // entry and pick up the restorable one. A single session-status carries the
      // new (exited, restorable) descriptor.
      this.emitStatus(appSessionId)
    }
    return { ok: true, value: undefined }
  }

  /* --------------------------------------------------------------------- *
   * setTitle — the P4-6 title-rider's GENERATION half (wired 2026-07-14)
   * --------------------------------------------------------------------- *
   *
   * The sidecar generates an AI session title after a fresh session's first turn
   * (reusing the engine's `generateSessionTitle`, the same machinery the TUI
   * uses) and pushes it via the one-shot `session-title` frame; main relays it
   * here. Durable via the registry (survives restart → restorable rows keep the
   * title); `emitStatus` propagates the updated descriptor so the sidebar/tab
   * relabel live from the cwd-basename fallback. Display text only — length-
   * capped here (`capTitle`). No-op on a malformed id, an empty title, or a
   * vanished row (a race with close/evict), never a throw.
   */
  async setTitle(appSessionId: SessionId, title: string): Promise<void> {
    await this.launched
    if (!isUuid(appSessionId)) return
    const capped = capTitle(title)
    if (capped === undefined || capped.length === 0) return
    await this.registry.setTitle(appSessionId, capped)
    this.emitStatus(appSessionId)
  }

  /* --------------------------------------------------------------------- *
   * listSessions — live ∪ restorable (§6)
   * --------------------------------------------------------------------- */

  listSessions(): SessionDescriptor[] {
    const byId = new Map<SessionId, SessionDescriptor>()
    // Restorable rows first — but ONLY genuinely restorable ones (SF7). The
    // registry's `restorable()` is the launch restore-ORDERING (all rows sorted);
    // the live∪restorable UNION excludes rows that are neither live nor
    // restorable — e.g. a clean row that never acquired an engineSessionId, or a
    // spawn_failed row marked clean before any ready frame. Those are not a tab
    // and not a restore.
    for (const row of this.registry.restorable()) {
      if (row.engineSessionId === null) continue
      byId.set(row.appSessionId, this.descriptorFromRow(row, null))
    }
    // …then live sessions overwrite (a live session's status wins over its row).
    for (const live of this.supervisor.listSessions()) {
      const descriptor = this.descriptorFor(live.sessionId)
      if (descriptor) byId.set(live.sessionId, descriptor)
    }
    return [...byId.values()]
  }

  /* --------------------------------------------------------------------- *
   * restartSession — restart in place, refreshing the registry advisory fields
   * (SF5). Routed through the host so a restarted sidecar's new pid/socketPath
   * land in the row; a bare `supervisor.restartSession` would leave stale
   * advisory fields that weaken the D6 crash-reap (§9-A3 identity match).
   * --------------------------------------------------------------------- */

  async restartSession(appSessionId: SessionId): Promise<HostResult<void>> {
    await this.launched
    if (!isUuid(appSessionId)) {
      return hostError('session_not_found', 'malformed session id')
    }
    if (!this.isLive(appSessionId)) {
      return hostError('session_not_found', `session ${appSessionId} is not live`)
    }
    const row = this.registry.findSession(appSessionId)
    if (!row) {
      return hostError('session_not_found', `session ${appSessionId} has no registry row`)
    }
    // Evict replay BEFORE the restart (mirrors the prior main behavior + P3-0).
    this.evictReplay(appSessionId)
    this.supervisor.restartSession(appSessionId, {
      cwd: row.cwd,
      ...(row.engineSessionId !== null
        ? { resumeEngineSessionId: row.engineSessionId }
        : {}),
    })
    // Refresh advisory fields from the fresh child (new pid + socketPath). The
    // row stays live; upsertOnSpawn bumps restartCount and rewrites the hints.
    await this.registry.upsertOnSpawn({
      appSessionId,
      cwd: row.cwd,
      ...(row.title !== undefined ? { title: row.title } : {}),
      enginePid: this.supervisor.getSessionProcessId(appSessionId),
      socketPath: this.supervisor.getSessionSocketPath(appSessionId),
    })
    this.surfaceRegistryHealth(appSessionId)
    this.emitStatus(appSessionId)
    return { ok: true, value: undefined }
  }

  /* --------------------------------------------------------------------- *
   * shutdownAll — die-with-window (B3). SYNCHRONOUS: mark every LIVE row clean
   * (one atomic write) + evict its replay, THEN kill the sidecars. A clean quit
   * must not masquerade as crash recovery on the next launch (which the orphan
   * sweep would report if rows stayed `shutdown:null`). Rows are KEPT
   * (restorable), same as closeSession. Sync because it runs on
   * `window-all-closed`/`before-quit`, where the process may exit before an async
   * persist could settle.
   * --------------------------------------------------------------------- */

  shutdownAll(): void {
    const marked = this.registry.markLiveCleanSync()
    for (const appSessionId of marked) {
      this.evictReplay(appSessionId)
    }
    this.supervisor.shutdown()
  }

  /* --------------------------------------------------------------------- *
   * canPreview — the IS-A transcript-cache gate (read-only)
   * --------------------------------------------------------------------- */

  /**
   * Instant session open (IS-A): may the renderer fetch this session's at-rest
   * transcript cache? True ONLY for a session that is NOT live, HAS a registry
   * row, and HAS a non-null `engineSessionId` — i.e. exactly the descriptor's
   * `restorable` flag, which `isRestorable(row, liveStatus)` already forces false
   * when a process is live (`host.ts:639-645`). Reusing the descriptor keeps the
   * not-live guard in one place; a LIVE or unknown id returns false, so main
   * never reads a cache off disk for an id the host does not vouch for (the IS-A
   * boundary-test requirement — main-side validation before any disk touch).
   */
  canPreview(appSessionId: SessionId): boolean {
    if (!isUuid(appSessionId)) return false
    return (
      this.listSessions().find(s => s.appSessionId === appSessionId)?.restorable ===
      true
    )
  }

  /* --------------------------------------------------------------------- *
   * subscribe — HostEvent stream (the renderer's list is a projection, never a
   * poll loop)
   * --------------------------------------------------------------------- */

  subscribe(cb: (event: HostEvent) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  /* --------------------------------------------------------------------- *
   * HC4 — spawn limits
   * --------------------------------------------------------------------- */

  private checkSpawnLimits(): { ok: false; error: HostError } | null {
    // Concurrency bound: live engine processes. Deliberately NOT the registry's
    // row bound (`MAX_REGISTRY_SESSIONS`) — that one covers live + terminal rows
    // and is a file-growth backstop, so tying process concurrency to it meant
    // raising the row bound would raise the fork-bomb cap too. The reap only
    // trims TERMINAL rows; live rows are never evicted to make room.
    if (this.liveCount() >= MAX_LIVE_SESSIONS) {
      return hostError('session_limit', `at most ${MAX_LIVE_SESSIONS} live sessions`)
    }
    // Rate cap: fork-bomb defense (extends T7 to process creation).
    const cutoff = this.now() - SPAWN_RATE_WINDOW_MS
    const recent = this.spawnTimes.filter(t => t > cutoff)
    if (recent.length >= MAX_SPAWNS_PER_WINDOW) {
      this.spawnTimes = recent
      return hostError(
        'session_limit',
        `spawn rate cap: ${MAX_SPAWNS_PER_WINDOW} per ${SPAWN_RATE_WINDOW_MS}ms`,
      )
    }
    return null
  }

  private recordSpawnTime(): void {
    const cutoff = this.now() - SPAWN_RATE_WINDOW_MS
    this.spawnTimes = this.spawnTimes.filter(t => t > cutoff)
    this.spawnTimes.push(this.now())
  }

  private liveCount(): number {
    return this.supervisor.listSessions().length
  }

  /* --------------------------------------------------------------------- *
   * Descriptor derivation
   * --------------------------------------------------------------------- */

  private isLive(appSessionId: SessionId): boolean {
    return this.supervisor.listSessions().some(s => s.sessionId === appSessionId)
  }

  /** Descriptor for a currently-live session (status from the supervisor). */
  private descriptorFor(appSessionId: SessionId): SessionDescriptor | undefined {
    const live = this.supervisor
      .listSessions()
      .find(s => s.sessionId === appSessionId)
    const row = this.registry.findSession(appSessionId)
    if (!live && !row) return undefined
    // A terminal supervisor record ('exited'/'failed') is a TOMBSTONE kept for
    // the tab's restart-in-place affordance — the process is dead. When the row
    // survives, project it exactly like any dead session so crash-marking and
    // restorability surface the same for a kill as for a graceful close (the
    // P3-5b kill/close parity fix): before this, the tombstone made the
    // descriptor read (status:'exited', restorable:false) and a crashed session
    // never became a Sidebar restore-offer.
    // A terminal record with NO row (its terminal row was bound-reaped while
    // the tombstone lingered) is neither live nor restorable — return
    // undefined rather than minting an empty-id ghost descriptor (SF7).
    if (!live || isTerminalStatus(live.status)) {
      return row ? this.descriptorFromRow(row, null) : undefined
    }
    return this.descriptorFromRow(row, live.status)
  }

  /**
   * Merge a registry row (durable identity) with a live supervisor status. When
   * `liveStatus` is null the session is not currently live (restorable/exited).
   * A dead session's status carries the row's crash marking: `disconnected` for
   * a crash-marked row vs `exited` for a clean close — the ONE signal that lets
   * the Sidebar flag a crash distinctly from a close (REGISTRY §4.4; see the
   * status doc in app/shared/hostApi.ts).
   */
  private descriptorFromRow(
    row: RegistrySession | undefined,
    liveStatus: SidecarStatus | null,
  ): SessionDescriptor {
    const status = liveStatus
      ? mapStatus(liveStatus)
      : // IDLE-PARK (decisions/IDLE-PARK.md §1/§5): a `'parked'` row projects
        // BYTE-IDENTICALLY to a crash — `disconnected` + `restorable` — so the
        // tab is kept (foldTabMembership) and no renderer/descriptor code is
        // aware park exists. `isRestorable` already returns true for any dead row
        // with an engineSessionId, so a parked row is restorable with no change.
        row?.shutdown === 'crashed' || row?.shutdown === 'parked'
        ? 'disconnected'
        : 'exited'
    return {
      appSessionId: row?.appSessionId ?? '',
      engineSessionId: row?.engineSessionId ?? null,
      cwd: row?.cwd ?? '',
      title: row?.title ?? null,
      // null ⇒ the app never recorded a title intent for this row, so the
      // renderer lets a real transcript title win (the terminal-rename fix).
      titleUpdatedAt: row?.titleUpdatedAt ?? null,
      status,
      restorable: this.isRestorable(row, liveStatus),
      createdAt: row?.createdAt ?? 0,
      lastAttachedAt: row?.lastAttachedAt ?? 0,
      // CC-2: the sidebar reads this for its recency text; null → the row falls
      // back to `createdAt`, never to `lastAttachedAt` (the bug this fixes).
      lastMessageSentAt: row?.lastMessageSentAt ?? null,
    }
  }

  /**
   * A session is restorable when a registry row exists with a known
   * engineSessionId (transcript key) AND no process is currently live for it.
   * `restorable` means "no process is live but the row can be re-spawned"
   * (app/shared/hostApi.ts:74) — a LIVE session is never a restore candidate
   * (restoreSession rejects an already-live id), so `liveStatus != null` forces
   * `false`. The launch reap already dropped rows whose transcript is gone, so a
   * non-live row that survived launch WITH an engineSessionId is re-spawnable.
   */
  private isRestorable(
    row: RegistrySession | undefined,
    liveStatus: SidecarStatus | null,
  ): boolean {
    if (liveStatus !== null) return false
    return !!row && row.engineSessionId !== null
  }

  /* --------------------------------------------------------------------- *
   * HostEvent emit helpers
   * --------------------------------------------------------------------- */

  private emit(event: HostEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  private emitStatus(appSessionId: SessionId): void {
    const descriptor = this.descriptorFor(appSessionId)
    if (descriptor) {
      this.emit({ type: 'session-status', session: descriptor })
    }
  }

  private emitRemoved(appSessionId: SessionId): void {
    this.emit({ type: 'session-removed', appSessionId })
  }

  /**
   * Surface a degraded registry write as a non-fatal `registry_unavailable`
   * (HC/§6.1). The session is unaffected; only persistence degraded.
   */
  private surfaceRegistryHealth(appSessionId: SessionId): void {
    if (this.registry.lastWriteFailed) {
      this.log(
        `[host] registry_unavailable: persistence degraded for ${appSessionId}; ` +
          'session is live and unaffected',
      )
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Module-private helpers
 * ------------------------------------------------------------------------- */

/**
 * A supervisor record in a terminal state is a dead process whose record is
 * kept only as the restart-in-place tombstone (the supervisor deregisters on
 * killSession, NOT on child exit) — never a live session for descriptor or
 * restore purposes.
 */
function isTerminalStatus(status: SidecarStatus): boolean {
  return status === 'exited' || status === 'failed'
}

/** Supervisor status → the coarser descriptor status the renderer consumes. */
function mapStatus(status: SidecarStatus): SessionDescriptor['status'] {
  switch (status) {
    case 'spawning':
    case 'connecting':
      return 'spawning'
    case 'ready':
      return 'ready'
    case 'disconnected':
    case 'failed':
      return 'disconnected'
    case 'exited':
      return 'exited'
  }
}

function capTitle(title: string | undefined): string | undefined {
  if (typeof title !== 'string') return undefined
  return title.slice(0, MAX_SESSION_TITLE_CHARS)
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
