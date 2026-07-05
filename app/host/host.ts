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
import { MAX_REGISTRY_SESSIONS } from './registry.js'
import type {
  SidecarStatus,
  SidecarSupervisor,
  SupervisorEvent,
} from '../supervisor/supervisor.js'
import type { SessionId } from '../shared/protocol.js'
import {
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
   * appSessionIds currently gracefully closing. `killSession` fires an async
   * `exit` event; without this we would emit `session-status(exited)` for a row
   * we already reported as `session-removed`/clean.
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
      }
      return
    }

    if (event.type === 'exit') {
      // A graceful close already marked the row clean + emitted removed; don't
      // re-report the async exit that killSession triggers.
      if (!this.closing.has(appSessionId)) {
        // F3 — an exit the host did not ask for IS the crash, and this event is
        // the only moment the host knows it. Record it now; a later quit's
        // markLiveCleanSync must not relabel a mid-run crash as a clean
        // shutdown (markCrashed only transitions live rows, so the
        // shutdownAll mark-clean-then-kill ordering is unaffected).
        await this.registry.markCrashed(appSessionId)
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
    // before this is called (`req.cwd` is main-supplied, never a renderer string),
    // and `req.resumeEngineSessionId` is only ever set by `restoreSession` from a
    // registry row — the renderer create surface carries neither. This
    // canonicalize + existence check is the defense-in-depth backstop.
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
      // as a live crash on the next sweep, and report spawn_failed.
      await this.registry.markClean(appSessionId)
      this.emitRemoved(appSessionId)
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

    // The row still exists (restorable) but is no longer live — the session left
    // the "live" half of the union, so the list projection must drop the live
    // entry and pick up the restorable one. A single session-status carries the
    // new (exited, restorable) descriptor.
    this.emitStatus(appSessionId)
    return { ok: true, value: undefined }
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
    // Evict replay BEFORE the restart (mirrors the prior main behavior + P3-0).
    this.evictReplay(appSessionId)
    this.supervisor.restartSession(appSessionId)
    // Refresh advisory fields from the fresh child (new pid + socketPath). The
    // row stays live; upsertOnSpawn bumps restartCount and rewrites the hints.
    const row = this.registry.findSession(appSessionId)
    await this.registry.upsertOnSpawn({
      appSessionId,
      cwd: row?.cwd ?? '',
      ...(row?.title !== undefined ? { title: row.title } : {}),
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
    // Row bound: live sessions + restorable rows. A create that would exceed the
    // registry bound is refused (the reap only trims TERMINAL rows; live ones
    // must not be evicted to make room).
    if (this.liveCount() >= MAX_REGISTRY_SESSIONS) {
      return hostError(
        'session_limit',
        `at most ${MAX_REGISTRY_SESSIONS} live sessions`,
      )
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
      : row?.shutdown === 'crashed'
        ? 'disconnected'
        : 'exited'
    return {
      appSessionId: row?.appSessionId ?? '',
      engineSessionId: row?.engineSessionId ?? null,
      cwd: row?.cwd ?? '',
      title: row?.title ?? null,
      status,
      restorable: this.isRestorable(row, liveStatus),
      createdAt: row?.createdAt ?? 0,
      lastAttachedAt: row?.lastAttachedAt ?? 0,
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
