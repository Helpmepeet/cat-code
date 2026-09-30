import { isRelocationControls, readSessionRelocation, writeSessionRelocation, type RelocationControls, type SessionLocation } from '../../src/utils/sessionRelocationState.js'
import type { RelocationRequest } from '../../src/utils/sessionRelocation.js'
import type { RunControlsSnapshot } from '../shared/protocol.js'
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
import { lstatSync, readFileSync } from 'node:fs'

import type { SessionRegistry, RegistrySession } from './registry.js'
import { MAX_REGISTRY_SESSIONS, defaultTranscriptPath } from './registry.js'
import { pickPeerName, randomPeerNameCursor } from './peerNames.js'
import type {
  SidecarStatus,
  SidecarSupervisor,
  SupervisorEvent,
} from '../supervisor/supervisor.js'
import type { SessionId } from '../shared/protocol.js'
import type { SessionBinding } from '../shared/sessionBinding.js'
import { ManagedStorage } from './managedStorage.js'
import {
  AUTO_RESTORE_UNAVAILABLE_EXIT,
  PARKED_EXIT_CODE,
  RESUME_BUSY_EXIT_CODE,
  RESUME_FAILED_EXIT_CODE,
} from '../shared/limits.js'

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

class AutoRestoreUnavailableError extends Error {
  constructor(readonly reason: string) { super(`Auto mode is unavailable ${reason}`) }
}

function autoRestoreRefusal(code: number | null): AutoRestoreUnavailableError | null {
  if (code === AUTO_RESTORE_UNAVAILABLE_EXIT.feature) return new AutoRestoreUnavailableError('because the classifier feature is unavailable')
  if (code === AUTO_RESTORE_UNAVAILABLE_EXIT.settings) return new AutoRestoreUnavailableError('because the destination settings disable it')
  if (code === AUTO_RESTORE_UNAVAILABLE_EXIT['circuit-breaker']) return new AutoRestoreUnavailableError('because its circuit breaker is active')
  if (code === AUTO_RESTORE_UNAVAILABLE_EXIT.model) return new AutoRestoreUnavailableError('for the selected model in this project')
  return null
}

/* ------------------------------------------------------------------------- *
 * Injected dependencies (main provides the electron-bound / real-fs ones; tests
 * pass hermetic fakes so this module runs without electron and without a real
 * process tree).
 * ------------------------------------------------------------------------- */

export type CwdValidation = { ok: true; realpath: string } | { ok: false }

/**
 * Peer-session inputs for a spawn (PEER-SESSIONS §2/§4, HOST-REQUEST-PLANE HR4).
 *
 * Deliberately NOT on the `HostApi` interface: main's peer-request handler holds
 * the concrete `Host`, while the renderer reaches `createSessionInWorkspace`
 * through a fixed preload sender that passes an id and nothing else. Keeping
 * this off the renderer-facing type is what makes it structurally impossible for
 * a compromised renderer to author a creator or a churn exemption. A NAME is not
 * authorable by anyone, on any plane: the picker in main owns the whole set.
 */
export type PeerSpawnOptions = {
  /**
   * The creating session's `appSessionId` — an id, never a name (§2).
   *
   * There is deliberately NO caller-supplied NAME here. PEER-SESSIONS §2 makes
   * the allocator an owned picker in main and rules user-chosen call signs out
   * of v1; §4's `CreatePeer` takes a prompt and optional model/effort and
   * nothing else. A name parameter would also be an unvalidated free-text path
   * into `CATCODE_SIDECAR_NAME` and from there into the doctrine block, which is
   * fixed at controller construction and can never be re-checked.
   */
  createdBy?: SessionId
  /** Model / effort the new session starts on (R7), carried in the spawn env. */
  model?: string
  effort?: string
  /**
   * HR4 — apply the registry churn rule to THIS create: refuse with
   * `session_limit` when the registry is at `MAX_REGISTRY_SESSIONS` rows and the
   * bound-reap could remove none of them. Opt-in because the rule exists for the
   * one caller that can create-park-create at machine speed; a person clicking
   * "+" cannot, and refusing them a tab because 256 rows are parked would be a
   * regression, not a guard.
   */
  enforceRegistryChurnLimit?: boolean
}
type SpawnReservation = {
  ok: true
  token: string
  consumesLive: boolean
}

export type HostOptions = {
  hasPendingSubmit?: (appSessionId: SessionId) => boolean
  supervisor: SidecarSupervisor
  registry: SessionRegistry
  /**
   * HC1 — canonicalize + existence/isDirectory check a cwd, regardless of
   * origin. Main injects the real `realpathSync` + `statSync().isDirectory()`;
   * tests inject a controllable check. Returns the canonical path on success so
   * the row and the spawn both use the SAME resolved path (no symlink skew).
   */
  validateCwd: (cwd: string) => CwdValidation
  /** Host-owned storage allocator; app-data base is supplied by Electron main. */
  managedStorage?: ManagedStorage
  relocate?: (request: RelocationRequest) => Promise<void>
  /** Current peer-plane activity and unconsumed deliveries at the move gate. */
  peerMoveState?: (appSessionId: SessionId) => { presence?: 'running' | 'needs_user' | 'idle'; pending: number; reservations?: number }
  /** Release deferred peer deliveries after the moved row's scope is final. */
  peerMoveSettled?: (appSessionId: SessionId) => void
  /** Clear a failed move's partial bootstrap and arm history replay for recovery. */
  prepareMoveReplayRecovery?: (appSessionId: SessionId, options: { persistSourceCache: boolean }) => void
  cancelMoveReplayCoalescing?: (appSessionId: SessionId) => void
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
  private readonly hasPendingSubmit: (appSessionId: SessionId) => boolean
  private readonly supervisor: SidecarSupervisor
  private readonly registry: SessionRegistry
  private readonly validateCwd: (cwd: string) => CwdValidation
  private readonly managedStorage?: ManagedStorage
  private readonly relocate?: HostOptions['relocate']
  private readonly peerMoveState?: HostOptions['peerMoveState']
  private readonly peerMoveSettled?: HostOptions['peerMoveSettled']
  private readonly prepareMoveReplayRecovery?: HostOptions['prepareMoveReplayRecovery']
  private readonly cancelMoveReplayCoalescing?: HostOptions['cancelMoveReplayCoalescing']
  private readonly moving = new Set<SessionId>()
  private readonly runControls = new Map<SessionId, RunControlsSnapshot>()
  private readonly permissionModes = new Map<SessionId, string>()
  private readonly prePlanModes = new Map<SessionId, string>()
  private readonly permissionClassifierAvailable = new Map<SessionId, boolean>()
  private readonly evictReplay: (appSessionId: SessionId) => void
  private readonly log: (line: string) => void
  private readonly now: () => number

  private readonly listeners = new Set<(event: HostEvent) => void>()

  /**
   * Spawn-rate reservations. A token remains after a child is committed, but is
   * removed when persistence or synchronous process creation fails so a refused
   * attempt cannot consume the fork budget.
   */
  private spawnTimes: Array<{ token: string; timestamp: number }> = []
  /** Live slots admitted before the supervisor has registered its child. */
  private pendingLiveSlots = 0
  /** All unfinished spawn reservations, including restarts that reuse a slot. */
  private pendingSpawns = 0
  private branchSwitching = false
  /** One restore owns a registry id from validation through child registration. */
  private readonly restoring = new Set<SessionId>()
  /** Internal relocation warmups must not open a closed Chat in the renderer. */
  private readonly hiddenMoveWarmups = new Set<SessionId>()

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

  /**
   * appSessionIds a sidecar has PROVEN unresumable this run by exiting
   * `RESUME_FAILED_EXIT_CODE`: the engine could not load their transcript
   * (missing, or present with no loadable conversation —
   * `app/sidecar/sessionResume.ts`). `canResume` refuses them, so such a row
   * stops being offered and stops being retried instead of failing on every
   * click — the same doctrine the sessions catalog already applies to
   * `hasConversation === false` rows (`app/sidecar/sessionsCatalogDomain.ts`).
   *
   * Deliberately IN-MEMORY, and deliberately for the remainder of the run: it is
   * a cached engine verdict, not registry state (the schema gains nothing, §3),
   * and a relaunch re-earns it — where the launch reap gets a fresh look at the
   * transcript anyway. A verdict that expired sooner would just re-arm the retry
   * loop this exists to break.
   */
  private readonly resumeFailed = new Set<SessionId>()

  /** Resolves once the registry launch sweep has completed (B4 / REGISTRY §4). */
  private readonly launched: Promise<unknown>

  /**
   * Where the peer-name picker resumes (PEER-SESSIONS §2). Seeded randomly so a
   * fresh launch does not always hand out the same first name, then advanced by
   * each allocation. In-memory only: the registry rows ARE the reservation set,
   * so a lost cursor costs nothing but a re-scan from a different offset.
   */
  private peerNameCursor = randomPeerNameCursor()

  constructor(options: HostOptions) {
    this.hasPendingSubmit = options.hasPendingSubmit ?? (() => false)
    this.supervisor = options.supervisor
    this.registry = options.registry
    this.validateCwd = options.validateCwd
    this.relocate = options.relocate
    this.peerMoveState = options.peerMoveState
    this.peerMoveSettled = options.peerMoveSettled
    this.prepareMoveReplayRecovery = options.prepareMoveReplayRecovery
    this.cancelMoveReplayCoalescing = options.cancelMoveReplayCoalescing
    this.managedStorage = options.managedStorage
    this.evictReplay = options.evictReplay ?? (() => {})
    this.log = options.log ?? (line => process.stderr.write(`${line}\n`))
    this.now = options.now ?? Date.now
    // Never reject the gate — a failed launch already logged and started empty;
    // ops proceed against the in-memory doc (the registry is an index, not a
    // backup). We only need the sweep's read-modify-write to have SETTLED first.
    // The name repair joins the gate rather than following it: every op already
    // awaits this, so no caller can read a row mid-repair and cache it nameless.
    this.launched = (options.launched ?? Promise.resolve())
      .then(async () => {
        await this.repairManagedBindings()
        await this.nameUnnamedRows()
      })
      .catch(() => undefined)
    this.wireSupervisor()
  }

  /* --------------------------------------------------------------------- *
   * Supervisor event → registry row updates + HostEvent stream
   * --------------------------------------------------------------------- */

  private wireSupervisor(): void {
    this.supervisor.subscribe(event => {
      void this.onSupervisorEvent(event).catch(error => {
        this.log(`[host] supervisor event could not be recorded: ${errText(error)}`)
      })
    })
  }

  private async onSupervisorEvent(event: SupervisorEvent): Promise<void> {
    const appSessionId = event.sessionId

    if (event.type === 'frame') {
      if (event.frame.kind === 'ready') {
        this.runControls.delete(appSessionId)
        this.permissionModes.delete(appSessionId)
        this.prePlanModes.delete(appSessionId)
        this.permissionClassifierAvailable.delete(appSessionId)
      }
      if (event.frame.kind === 'run-controls.snapshot') {
        this.runControls.set(appSessionId, event.frame.runControls)
        this.updateRelocationControls(appSessionId, {
          model: event.frame.runControls.model.selected ?? null,
          ...(event.frame.runControls.effort.selected ? { effort: event.frame.runControls.effort.selected } : {}),
          fastMode: event.frame.runControls.fast.active,
        }, true)
      }
      if (event.frame.kind === 'permission.context') {
        this.permissionModes.set(appSessionId, event.frame.context.mode)
        if (event.frame.context.prePlanMode) this.prePlanModes.set(appSessionId, event.frame.context.prePlanMode)
        else this.prePlanModes.delete(appSessionId)
        this.permissionClassifierAvailable.set(appSessionId, event.frame.context.permissionClassifierEnabled)
        const mode = event.frame.context.mode
        if (mode === 'default' || mode === 'acceptEdits' || mode === 'plan' || mode === 'dontAsk' || mode === 'auto') {
          this.updateRelocationControls(appSessionId, {
            mode,
            prePlanMode: mode === 'plan' && (
              event.frame.context.prePlanMode === 'default' ||
              event.frame.context.prePlanMode === 'acceptEdits' ||
              event.frame.context.prePlanMode === 'dontAsk' ||
              event.frame.context.prePlanMode === 'auto'
            ) ? event.frame.context.prePlanMode : undefined,
          })
        }
      }
      // Relay the ready frame's engineSessionId into the registry row (the
      // two-id bridge, REGISTRY.md §2). Only the ready frame carries it.
      if (event.frame.kind === 'ready') {
        const row = this.registry.findSession(appSessionId)
        if (row?.binding.kind === 'managed') {
          const recorded = this.managedStorage?.recordSessionIdentity(row.binding, appSessionId, event.frame.engineSessionId)
          if (!recorded) this.log(`[host] could not durably record managed engine identity for ${appSessionId}`)
        }
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
        if (!frame.replay && frame.event.type === 'message' && frame.event.message.type === 'user') {
          await this.registry.markInputAccepted(appSessionId)
          const row = this.registry.findSession(appSessionId)
          if (row?.engineSessionId) {
            try {
              const move = readSessionRelocation(row.engineSessionId)
              if (move?.phase === 'complete' && move.empty === true && move.appSessionId === appSessionId) {
                const { empty: _empty, ...withInput } = move
                writeSessionRelocation(withInput)
              }
            } catch (error) { this.log(`[host] could not mark first moved input: ${errText(error)}`) }
          }
        }
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
        } else if (event.code === RESUME_BUSY_EXIT_CODE) {
          // A different process owns the transcript. This is retryable, not a
          // crashed engine and not evidence that the transcript is unusable.
          await this.registry.markClean(appSessionId)
          this.log(
            `[host] resume_busy: ${appSessionId} remains restorable until the other owner exits`,
          )
        } else {
          // A `RESUME_FAILED_EXIT_CODE` exit is the engine reporting that this
          // row's `engineSessionId` has no loadable transcript — the sidecar
          // exits ONLY for `SidecarResumeError`, and only on a spawn that asked
          // for a resume, so the code is unambiguous (nothing else in the engine
          // or the app exits 4). The row is still crash-marked (the process did
          // die unasked) and keeps its tab, but the id is now proven
          // unresumable: `canResume` refuses it, so the descriptor stops
          // advertising `restorable` and neither `restoreSession` nor
          // `restartSession` will retry the resume that just failed. Recorded
          // BEFORE the mark so the status emitted below already carries it.
          if (event.code === RESUME_FAILED_EXIT_CODE) {
            this.resumeFailed.add(appSessionId)
            this.log(
              `[host] resume_failed: ${appSessionId} has no loadable transcript; ` +
                'no longer offered as restorable this run',
            )
          }
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
    const binding = req.binding ?? { kind: 'project' as const }
    let expectedManagedCwd: string | undefined
    if (binding.kind === 'managed') {
      const resolution = this.managedStorage?.resolve(binding)
      if (!resolution?.ok) return hostError('managed_storage_invalid', 'managed chat storage is unavailable')
      expectedManagedCwd = resolution.cwd
    }
    const validated = this.validateCwd(req.cwd)
    if (!validated.ok) {
      return hostError(
        'invalid_cwd',
        `cwd is not an existing directory: ${req.cwd}`,
      )
    }
    const cwd = validated.realpath
    if (expectedManagedCwd !== undefined && cwd !== expectedManagedCwd) {
      return hostError('invalid_cwd', 'managed chat cwd does not match its host binding')
    }

    const appSessionId = req.appSessionId ?? randomUUID()
    if (!isUuid(appSessionId)) return hostError('session_not_found', 'malformed session id')
    if (binding.kind === 'managed' && !this.managedStorage?.recordSessionIdentity(binding, appSessionId, req.resumeEngineSessionId)) {
      return hostError('managed_storage_invalid', 'managed chat ownership could not be recorded')
    }
    const reservation = this.reserveSpawn(true)
    if (!reservation.ok) return reservation.result
    return this.spawn({
      appSessionId,
      cwd,
      title: capTitle(req.title),
      resumeEngineSessionId: req.resumeEngineSessionId,
      forked: req.forked === true,
      binding,
    }, reservation)
  }

  async createManagedChat(): Promise<HostResult<SessionDescriptor>> {
    await this.launched
    if (!this.managedStorage) return hostError('managed_storage_invalid', 'managed chat storage is unavailable')
    const allocation = this.managedStorage.create()
    if (!allocation.ok) return hostError('managed_storage_invalid', 'could not create managed chat storage')
    const appSessionId = randomUUID()
    return this.createSession({ cwd: allocation.cwd, binding: allocation.binding, appSessionId })
  }

  /** Record a successful branch before its result reaches the renderer. */
  recordManagedBranch(sourceAppSessionId: SessionId, branchEngineSessionId: string): boolean {
    if (!isUuid(sourceAppSessionId) || !isUuid(branchEngineSessionId) || !this.managedStorage) return false
    const source = this.registry.findSession(sourceAppSessionId)
    if (!source || source.binding.kind !== 'managed') return false
    try {
      const resolved = this.managedStorage.resolve(source.binding)
      if (!resolved.ok || resolved.cwd !== source.cwd) return false
      const existing = this.managedStorage.findByEngineSession(branchEngineSessionId)
      if (existing) {
        return existing.appSessionId !== sourceAppSessionId &&
          existing.cwd === source.cwd &&
          existing.binding.storageRootId === source.binding.storageRootId &&
          existing.binding.storageId === source.binding.storageId
      }
      return this.managedStorage.recordSessionIdentity(source.binding, randomUUID(), branchEngineSessionId)
    } catch {
      return false
    }
  }

  hasManagedHistoryIdentity(engineSessionId: string): boolean {
    if (!isUuid(engineSessionId)) return false
    try {
      return this.managedStorage?.findByEngineSession(engineSessionId) !== undefined
    } catch {
      return false
    }
  }

  /** A managed prompt may run only after its engine id is durable in the ledger. */
  ensureManagedSubmitIdentity(appSessionId: SessionId): boolean {
    if (!isUuid(appSessionId)) return false
    const row = this.registry.findSession(appSessionId)
    if (!row || row.binding.kind !== 'managed') return true
    if (!row.engineSessionId || !this.managedStorage) return false
    try {
      return this.managedStorage.hasSessionIdentity(row.binding, appSessionId, row.engineSessionId) ||
        this.managedStorage.recordSessionIdentity(row.binding, appSessionId, row.engineSessionId)
    } catch {
      return false
    }
  }

  async adoptManagedHistorySession(
    engineSessionId: string,
    title?: string,
    forked = false,
  ): Promise<HostResult<SessionDescriptor>> {
    await this.launched
    if (!isUuid(engineSessionId)) return hostError('session_not_found', 'malformed engine session id')
    const owned = this.managedStorage?.findByEngineSession(engineSessionId)
    if (!owned) return hostError('session_not_found', 'no host-owned managed session record for this transcript')
    const alreadyRegistered = this.registry.findSession(owned.appSessionId) !== undefined
    await this.registry.registerManagedHistorySession({
      ...owned,
      engineSessionId,
      ...(title !== undefined ? { title } : {}),
      forked,
    })
    if (this.registry.lastWriteFailed) {
      return hostError('registry_unavailable', 'managed history binding could not be saved safely')
    }
    const descriptor = this.descriptorFor(owned.appSessionId)
    if (!descriptor) return hostError('session_not_found', 'managed history row could not be restored')
    this.emit({ type: alreadyRegistered ? 'session-status' : 'session-added', session: descriptor })
    return { ok: true, value: descriptor }
  }

  /** Reopen a reaped project-side Chat under its original app identity. */
  async openRelocatedHistorySession(
    engineSessionId: string,
    title?: string,
    forked = false,
  ): Promise<HostResult<SessionDescriptor> | null> {
    await this.launched
    if (!isUuid(engineSessionId)) return hostError('session_not_found', 'malformed engine session id')
    let move
    try { move = readSessionRelocation(engineSessionId) }
    catch { return hostError('session_unreachable', 'This Chat has an unreadable move record') }
    if (!move) return null
    if (move.phase !== 'complete') return hostError('session_unreachable', 'This Chat has an unfinished move. Restore its saved backup before reopening it')
    if (move.target.binding.kind !== 'project' || !this.managedStorage?.hasSessionIdentity(
      move.original.binding as Extract<SessionBinding, { kind: 'managed' }>, move.appSessionId, engineSessionId,
    )) return hostError('session_unreachable', 'This Chat’s original identity could not be verified')
    if (this.registry.findSession(move.appSessionId)) return hostError('session_unreachable', 'This Chat already has an app session')
    const validated = this.validateCwd(move.target.cwd)
    if (!validated.ok || validated.realpath !== move.target.cwd) return hostError('invalid_cwd', 'This Chat’s project folder is unavailable')
    const reservation = this.reserveSpawn(true)
    if (!reservation.ok) return reservation.result
    return this.spawn({
      appSessionId: move.appSessionId,
      cwd: move.target.cwd,
      binding: move.target.binding,
      ...(move.empty === true && ['empty', 'missing'].includes(this.emptyHistoryFile(move.target.cwd, engineSessionId))
        ? { freshEngineSessionId: engineSessionId }
        : { resumeEngineSessionId: engineSessionId }),
      title,
      forked,
      ...move.controls,
      permissionMode: move.controls.mode,
      preferSpawnModel: true,
    }, reservation)
  }

  async getSessionFolderState(appSessionId: SessionId): Promise<HostResult<'available' | 'missing'>> {
    await this.launched
    if (!isUuid(appSessionId)) return hostError('session_not_found', 'malformed session id')
    const row = this.registry.findSession(appSessionId)
    if (!row) return hostError('session_not_found', 'session not found')
    if (row.binding.kind !== 'managed') {
      const cwd = this.validateCwd(row.cwd)
      return { ok: true, value: cwd.ok ? 'available' : 'missing' }
    }
    if (!this.managedStorage) return hostError('managed_storage_invalid', 'managed chat storage is unavailable')
    const resolved = this.managedStorage.resolve(row.binding)
    if (resolved.ok) return { ok: true, value: 'available' }
    return resolved.reason === 'missing'
      ? { ok: true, value: 'missing' }
      : hostError('managed_storage_invalid', 'managed chat storage failed validation')
  }

  async recreateManagedChatFolder(appSessionId: SessionId): Promise<HostResult<SessionDescriptor>> {
    await this.launched
    if (!isUuid(appSessionId)) return hostError('session_not_found', 'malformed session id')
    const row = this.registry.findSession(appSessionId)
    if (!row) return hostError('session_not_found', 'session not found')
    if (row.binding.kind !== 'managed' || !this.managedStorage) {
      return hostError('managed_storage_invalid', 'this session has no managed chat folder')
    }
    const live = this.supervisor.listSessions().find(session => session.sessionId === appSessionId)
    if (live && !isTerminalStatus(live.status)) {
      return hostError('session_not_found', 'close this chat before recreating its folder')
    }
    const storage = this.managedStorage.resolve(row.binding)
    const folder = storage.ok
      ? storage
      : storage.reason === 'missing'
        ? this.managedStorage.recreate(row.binding)
        : storage
    if (!folder.ok) return hostError('managed_storage_invalid', 'managed chat folder could not be recreated safely')
    row.cwd = folder.cwd
    await this.registry.updateCwd(appSessionId, folder.cwd)
    if (row.engineSessionId !== null) return this.restoreSession(appSessionId)
    const reservation = this.reserveSpawn(true)
    if (!reservation.ok) return reservation.result
    return this.spawn({
      appSessionId,
      cwd: folder.cwd,
      title: row.title,
      resumeEngineSessionId: undefined,
      forked: row.forked,
      binding: row.binding,
    }, reservation)
  }

  async copySessionFolderPath(appSessionId: SessionId): Promise<HostResult<string>> {
    const state = await this.getSessionFolderState(appSessionId)
    if (!state.ok) return state
    const row = this.registry.findSession(appSessionId)
    if (!row) return hostError('session_not_found', 'session not found')
    const validated = row.binding.kind === 'managed'
      ? this.managedStorage?.resolve(row.binding)
      : undefined
    if (row.binding.kind === 'managed') {
      return validated?.ok ? { ok: true, value: validated.cwd } : hostError('managed_storage_invalid', 'managed chat storage failed validation')
    }
    const cwd = this.validateCwd(row.cwd)
    return cwd.ok ? { ok: true, value: cwd.realpath } : hostError('invalid_cwd', 'session folder is unavailable')
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
    // A duplicate restore must be a harmless refusal. In particular it must not
    // clear a just-created row or kill the winning child while the first restore
    // is between the registry write and supervisor registration.
    if (this.restoring.has(appSessionId)) {
      return hostError('session_not_found', `session ${appSessionId} is already restoring`)
    }
    this.restoring.add(appSessionId)
    try {
      return await this.restoreSessionExclusive(appSessionId)
    } finally {
      this.restoring.delete(appSessionId)
    }
  }

  private async restoreSessionExclusive(
    appSessionId: SessionId,
  ): Promise<HostResult<SessionDescriptor>> {
    const row = this.registry.findSession(appSessionId)
    // §9-A4: fails session_not_found if the row OR its transcript is gone. The
    // registry only offers restorable rows whose transcript exists (launch reap),
    // and a null engineSessionId row is not resumable.
    if (row?.engineSessionId === null && row.binding.kind === 'managed' && this.hasPendingSubmit(appSessionId)) {
      const live = this.supervisor.listSessions().find(item => item.sessionId === appSessionId)
      if (live && !isTerminalStatus(live.status)) return hostError('session_unreachable', 'This Chat is already connecting')
      const folder = this.managedStorage?.resolve(row.binding)
      if (!folder?.ok || folder.cwd !== row.cwd) return hostError('managed_storage_invalid', 'The Chat folder is unavailable')
      const reservation = this.reserveSpawn(true)
      if (!reservation.ok) return reservation.result
      this.supervisor.killSession(appSessionId)
      return this.spawn({ appSessionId, cwd: row.cwd, binding: row.binding, title: row.title, forked: row.forked }, reservation)
    }
    if (!row || row.engineSessionId === null) {
      return hostError(
        'session_not_found',
        `no restorable session ${appSessionId}`,
      )
    }
    if (this.moveRecordBlocked(row.engineSessionId)) {
      return hostError('session_unreachable', 'This Chat has an unfinished or unreadable move. Restore its saved backup before reopening it')
    }
    if (row.binding.kind === 'managed') {
      const storage = this.managedStorage?.resolve(row.binding)
      if (!storage?.ok) return hostError(storage?.reason === 'missing' ? 'managed_storage_missing' : 'managed_storage_invalid', 'this chat folder is missing or failed validation')
    }
    // Read the supervisor record ONCE, before the refusals that consult it: the
    // stranded-transport test below has to win over the advisory-pid test, which
    // fires for exactly the same row (a disconnected sidecar is still running,
    // so its pid, socket file and command marker all still match) and would
    // answer `session_not_found` again.
    const record = this.supervisor
      .listSessions()
      .find(s => s.sessionId === appSessionId)

    // A SETTLED `disconnected` record is a dead end this path cannot clear.
    // `reportSocketLoss` (`app/supervisor/supervisor.ts`) never schedules a
    // reconnect, so the only exits are a kill or an explicit restart in place —
    // both user-driven. Reporting it as not-found told the peer plane to wait
    // for a ready that can never arrive, which burned the whole wake timeout and
    // held one of the recipient's delivery slots for its duration before failing
    // anyway. The distinct code stops the wait; the row is still recoverable by
    // the user, which is why nothing here kills the stranded child.
    if (record?.status === 'disconnected') {
      return hostError(
        'session_unreachable',
        'this session lost its connection and can only be restarted in place',
      )
    }
    // §9-A4 (SF6) — re-check resumability NOW, not just at launch: the transcript
    // may have been pruned between launch and this restore, or a prior attempt
    // this run may already have proven the id unloadable. Never offer a restore
    // we cannot perform (which would exit `resume-failed` downstream).
    if (!this.canResume(appSessionId)) {
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
    // (spawnSession rejects a duplicate id). `disconnected` was already answered
    // above; what reaches here is `spawning`/`connecting`/`ready`, where waiting
    // for the row's next ready IS the right advice.
    if (record && !isTerminalStatus(record.status)) {
      return hostError(
        'session_not_found',
        `session ${appSessionId} is already live`,
      )
    }

    // Re-validate the row's cwd too (HC1 defense in depth: a row can go stale if
    // its directory was moved/deleted between launches).
    const managed = row.binding.kind === 'managed'
      ? this.managedStorage?.resolve(row.binding)
      : undefined
    const validatedCwd = row.binding.kind === 'managed'
      ? (managed?.ok ? { ok: true as const, realpath: managed.cwd } : { ok: false as const, reason: managed?.reason ?? 'invalid' })
      : this.validateCwd(row.cwd)
    if (!validatedCwd.ok) {
      return hostError(row.binding.kind === 'managed'
        ? (managed && !managed.ok && managed.reason === 'missing' ? 'managed_storage_missing' : 'managed_storage_invalid')
        : 'invalid_cwd', `session cwd no longer exists: ${row.cwd}`)
    }

    const relocationControls = this.restoredRelocationControls(row)
    const reservation = this.reserveSpawn(true)
    if (!reservation.ok) return reservation.result
    // Clear the crashed tombstone (guarded by `closing` so the fake/late exit
    // the kill fires is not re-reported as a fresh crash — same suppression as
    // closeSession; the child is already dead, so this only deregisters).
    if (record) {
      this.closing.add(appSessionId)
      try {
        this.supervisor.killSession(appSessionId)
      } catch (error) {
        this.releaseSpawnReservation(reservation)
        return hostError('spawn_failed', `could not replace session: ${errText(error)}`)
      } finally {
        this.closing.delete(appSessionId)
      }
    }

    return this.spawn({
      appSessionId,
      cwd: validatedCwd.realpath,
      title: row.title,
      ...(this.isEmptySession(row)
        ? { freshEngineSessionId: row.engineSessionId }
        : { resumeEngineSessionId: row.engineSessionId }),
      forked: row.forked,
      binding: row.binding,
      ...(relocationControls ? { ...relocationControls, permissionMode: relocationControls.mode } : {}),
      ...(relocationControls ? { preferSpawnModel: true } : {}),
      // PEER-SESSIONS §2/§5 + R1 — a restore of a created peer must rebuild the
      // SAME identity. The row keeps `createdBy`, but `spawn` reads the creator
      // only from its input, so omitting it here left `CATCODE_SIDECAR_CREATED_BY`
      // and `..._NAME` unset and the doctrine block, which is fixed at controller
      // construction, lost "You were created by …". Every wake goes through this
      // path, including the peer-message restore (HOST-REQUEST-PLANE §4 step 5).
      ...(row.createdBy !== undefined ? { createdBy: row.createdBy } : {}),
    }, reservation)
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
    peer?: PeerSpawnOptions,
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
    if (row.binding.kind === 'managed') {
      return hostError('session_not_found', 'managed chats cannot create project workspace sessions')
    }
    // HC1 — re-derive + re-validate the cwd from the host's own row (never a
    // renderer string, never a stale value: a row can go stale if its directory
    // was moved/deleted between launches). This is the load-bearing trust point.
    const validated = this.validateCwd(row.cwd)
    if (!validated.ok) {
      return hostError('invalid_cwd', `workspace cwd no longer exists: ${row.cwd}`)
    }

    // HR4 — checked BEFORE the spawn reservation, so a refusal costs no fork
    // budget. HC4's live cap and rate cap do not bound this: a parked row leaves
    // the live count and is exempt from the reap, so create-park-create would
    // grow the registry, the tab bar and main's peer state without limit.
    if (peer?.enforceRegistryChurnLimit && this.registry.atBoundWithNothingReapable()) {
      return hostError(
        'session_limit',
        `at most ${MAX_REGISTRY_SESSIONS} sessions, and none can be removed to make room`,
      )
    }

    const reservation = this.reserveSpawn(true)
    if (!reservation.ok) return reservation.result

    // FRESH session in that workspace: a NEW appSessionId + NO
    // resumeEngineSessionId (this is a new session, not a restore of the named one).
    return this.spawn({
      appSessionId: randomUUID(),
      cwd: validated.realpath,
      title: undefined,
      resumeEngineSessionId: undefined,
      forked: false,
      binding: { kind: 'project' },
      ...(peer?.createdBy !== undefined ? { createdBy: peer.createdBy } : {}),
      ...(peer?.model !== undefined ? { model: peer.model } : {}),
      ...(peer?.effort !== undefined ? { effort: peer.effort } : {}),
    }, reservation)
  }

  /* --------------------------------------------------------------------- *
   * Shared spawn path (create + restore) — upsert row, spawn sidecar, record
   * advisory fields, emit session-added.
   * --------------------------------------------------------------------- */

  private async spawn(input: {
    appSessionId: SessionId
    cwd: string
    title: string | null | undefined
    resumeEngineSessionId?: string
    freshEngineSessionId?: string
    forked: boolean
    binding?: SessionBinding
    createdBy?: SessionId
    model?: string | null
    effort?: string
    permissionMode?: RelocationControls['mode']
    prePlanMode?: RelocationControls['prePlanMode']
    fastMode?: boolean
    preferSpawnModel?: boolean
  }, reservation: SpawnReservation): Promise<HostResult<SessionDescriptor>> {
    const { appSessionId, cwd, resumeEngineSessionId, forked } = input
    const title = input.title ?? undefined

    // PEER-SESSIONS §2 — every session is named, user-created and agent-created
    // alike. A row that has none by the time it is spawned gains one here; a
    // recently-active row that was never spawned again gained one at launch
    // (`nameUnnamedRows`), which is what keeps a closed row addressable at all.
    // This path is what makes the launch repair a one-time thing rather than an
    // ongoing rule: every row created from here on arrives named. Reuse the row's
    // name when it has one: the upsert below is write-once for the field, but
    // allocating a second name we then discard would burn a pool entry on every
    // restore.
    const existingRow = this.registry.findSession(appSessionId)
    const existingName = existingRow?.name
    const binding = input.binding ?? existingRow?.binding ?? { kind: 'project' as const }
    const isManaged = binding.kind === 'managed'
    const name = isManaged ? undefined : (existingName ?? this.allocatePeerName())
    const createdByName = this.creatorNameFor(
      input.createdBy,
      existingRow?.createdByName,
    )

    // Persist the live row BEFORE spawning so a crash between spawn and the next
    // launch still finds a row to sweep (REGISTRY.md §4.5 write points). The
    // upsert may reap terminal rows to stay under the bound — surface those as
    // session-removed so a subscriber's projection drops them (F5).
    // Seed `engineSessionId` from the resume target rather than waiting for the
    // ready frame to echo it back. Until it is set, the row cannot be joined to
    // its own transcript, so an opened history session rendered as a SECOND,
    // brand-new row at the top of the sidebar for the whole spawn window before
    // collapsing back into its real place (the visible "jump then settle").
    let rowPersisted = false
    try {
      const reaped = await this.registry.upsertOnSpawn({
        appSessionId,
        cwd,
        title,
        ...(resumeEngineSessionId !== undefined
          ? { engineSessionId: resumeEngineSessionId }
          : {}),
        forked,
        binding,
        ...(name !== undefined ? { name } : {}),
        ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {}),
        ...(createdByName !== undefined ? { createdByName } : {}),
      })
      rowPersisted = true
      if (binding.kind === 'managed' && this.registry.lastWriteFailed) {
        this.releaseSpawnReservation(reservation)
        return hostError('registry_unavailable', 'managed chat binding could not be saved safely')
      }
      for (const reapedId of reaped) {
        this.emitRemoved(reapedId)
      }
      this.supervisor.spawnSession(appSessionId, {
        cwd,
        binding,
        forked,
        recreatedFolderNotice: binding.kind === 'managed' &&
          this.managedStorage?.wasRecreated(binding) === true,
        ...(resumeEngineSessionId !== undefined ? { resumeEngineSessionId } : {}),
        ...(input.freshEngineSessionId !== undefined ? { freshEngineSessionId: input.freshEngineSessionId } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {}),
        ...(createdByName !== undefined ? { createdByName } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
        ...(input.prePlanMode !== undefined ? { prePlanMode: input.prePlanMode } : {}),
        ...(input.fastMode !== undefined ? { fastMode: input.fastMode } : {}),
        ...(input.preferSpawnModel === true ? { preferSpawnModel: true } : {}),
      })
      // The child is now supervisor-visible, so replace the in-flight slot with
      // the real live record before any later persistence await can yield.
      this.commitSpawnReservation(reservation)
    } catch (error) {
      // Spawn threw synchronously (e.g. socket-path overflow, duplicate id). The
      // row we just wrote is now dead — mark it clean so it does not masquerade
      // as a live crash on the next sweep, and report spawn_failed. A fresh
      // create's row (engineSessionId null, or an id whose transcript is gone) is
      // neither a tab nor an offer — remove it; a RESTORE's row is still a valid
      // restore-offer — a session-removed would hide it until relaunch (the
      // renderer pins removed ids), so re-emit its (exited, restorable) status
      // instead (SF-2, P3-5 review). Same restorable test as `closeSession`.
      this.releaseSpawnReservation(reservation)
      if (rowPersisted) await this.registry.markClean(appSessionId)
      const failedDescriptor = this.descriptorFor(appSessionId)
      if (failedDescriptor?.restorable) {
        this.emit({ type: 'session-status', session: failedDescriptor })
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
    if (!this.hiddenMoveWarmups.has(appSessionId)) this.emit({ type: 'session-added', session: descriptor })
    return { ok: true, value: descriptor }
  }

  /**
   * The creating session's NAME, for the child's spawn env (PEER-SESSIONS §5).
   *
   * The label has to be resolved HERE, on every path that starts a process,
   * because the sidecar cannot do it: `appendSystemPrompt` is fixed when the
   * controller is built, before the socket to main exists, and a sidecar may not
   * read the registry (CATALOG-OWNERSHIP). So a child handed only an id holds a
   * value it can never render. One helper rather than three copies of the
   * lookup, for spawn, restore and restart.
   *
   * The row's OWN stored label wins over a live lookup, and that order is the
   * whole point (F17, ruling 11). A live lookup returns nothing once the
   * creator's row is reaped, and a reap is exactly when its name can be reissued
   * to someone else, so a peer booted after one would hold an id it cannot pair
   * with a name, send with no expectation for main to check, and have the
   * message delivered to whoever now answers to that name. The stored label is
   * written once while the creator is still there and survives the reap, which
   * is what keeps `expectCreatorId` armed across park, restore and restart. The
   * earlier reasoning here, that a stale label would be worse than none, held
   * only while nothing verified the label against the id; it is the other way
   * round now, because a label plus an id is checkable and an id alone is not.
   *
   * Undefined only when this session had no creator, or when its row predates
   * the stored label and the creator's row is already gone.
   */
  private creatorNameFor(
    createdBy: string | undefined,
    stored?: string | undefined,
  ): string | undefined {
    if (createdBy === undefined) return undefined
    return stored ?? this.registry.findSession(createdBy)?.name
  }

  /**
   * Allocate a peer name (PEER-SESSIONS §2). Takes no preference: the picker in
   * main owns the whole set, and user-chosen call signs are out of v1.
   *
   * The reserved set is the names on ALL current registry rows — live, parked
   * and closed alike — because that is the uniqueness scope: a name is released
   * only when its row is reaped, and may be handed out again after that. The
   * cursor is in-memory and reseeded at every launch, so after a relaunch it
   * restarts at an arbitrary offset and THIS reserved set is the only thing
   * preventing a duplicate. `host.test.ts` drives that case directly.
   */
  private allocatePeerName(): string {
    const reserved = this.registry.sessions
      .map(row => row.name)
      .filter((value): value is string => typeof value === 'string')
    const picked = pickPeerName(reserved, this.peerNameCursor)
    this.peerNameCursor = picked.nextCursor
    return picked.name
  }

  /**
   * Repair rows that lost their name, once the launch sweep has settled and
   * before any op can read the rows (PEER-SESSIONS §2 — every session is
   * named). Idempotent: a row that already has a name is never renamed, so this
   * is a no-op on a registry the previous launch already repaired.
   *
   * It is not only a migration for rows that predate the field. `validateRow`
   * is a closed whitelist, so a build that predates `name` drops it from every
   * row it loads and writes the stripped document back at ITS launch — one run
   * of a stale packaged app leaves a fully-named registry with no names at all,
   * and nothing else ever puts them back: `upsertOnSpawn` only fills a name on
   * a row being spawned, and a nameless row is invisible to the peer tools that
   * would spawn it.
   *
   * Deliberately NOT every such row: the fill stops at `NAME_REPAIR_WINDOW_MS`
   * of `lastAttachedAt`, so a stale-build launch resurrects a readable roster
   * rather than the whole archive. Rows past the window keep no name for good;
   * the reasoning, and its cost, are on the constant. Nothing downstream needs
   * changing for that — every reader already tolerates a nameless row, because
   * that is the state this method is repairing.
   */
  private async nameUnnamedRows(): Promise<void> {
    const named = await this.registry.fillMissingNames(() =>
      this.allocatePeerName(),
    )
    if (named.length > 0) {
      this.log(
        `[host] named ${named.length} recently-active registry row(s) that had none`,
      )
    }
  }

  private async repairManagedBindings(): Promise<void> {
    if (!this.managedStorage) return
    const repaired = await this.registry.repairManagedBindings(row => {
      if (row.engineSessionId === null) return undefined
      try {
        return this.managedStorage?.findByEngineSession(row.engineSessionId)
      } catch {
        return undefined
      }
    })
    if (repaired > 0) this.log(`[host] recovered ${repaired} managed binding(s) from ownership records`)
  }

  /** Wait for launch recovery before exposing registry rows to an IPC caller. */
  async whenReady(): Promise<void> {
    await this.launched
  }

  /* --------------------------------------------------------------------- *
   * setPeerWakeBlocked — the user's one control over peer wake (PEER-SESSIONS
   * §6). Renderer-facing, `closeSession`-shaped: typed HostResult,
   * `session_not_found` for an unknown id (HC2), never a throw-through.
   * --------------------------------------------------------------------- */

  async setPeerWakeBlocked(
    appSessionId: SessionId,
    blocked: boolean,
  ): Promise<HostResult<void>> {
    await this.launched
    if (!isUuid(appSessionId)) {
      return hostError('session_not_found', 'malformed session id')
    }
    const updated = await this.registry.setPeerWakeBlocked(appSessionId, blocked === true)
    if (!updated) {
      return hostError('session_not_found', `unknown session ${appSessionId}`)
    }
    this.surfaceRegistryHealth(appSessionId)
    // The row menu renders from the descriptor, so the toggle must publish its
    // new state rather than leave the menu showing what the user just changed.
    // Published even when the write below failed, because the in-memory doc IS
    // the effective state for this run: the block is really on, it just will not
    // survive a relaunch, and a menu showing the old value would be wrong twice.
    this.emitStatus(appSessionId)
    // The degrade-not-die posture (§6.1, the file header) is about LIVENESS: a
    // session must outlive a persistence failure, so `createSession` and
    // `restartSession` report ok after a failed write and are left alone. This
    // control has no liveness to protect. Durability is the entire promise the
    // interface makes for it ("survives close, park, restore and relaunch"), and
    // `persist()` swallows all five of its failure modes, so an unwritable file
    // turned the one control the user has over peer wake into a toggle that
    // reported success and was gone at the next launch. Reported, not reverted:
    // rolling the row back would make the control do nothing THIS run either.
    if (this.registry.lastWriteFailed) {
      return hostError(
        'registry_unavailable',
        'this change could not be saved, so it will not survive a restart',
      )
    }
    return { ok: true, value: undefined }
  }

  /* --------------------------------------------------------------------- *
   * closeSession — graceful shutdown; row kept restorable + marked clean; MUST
   * evict replay state (the P3-0 carry).
   * --------------------------------------------------------------------- */

  async closeSession(appSessionId: SessionId): Promise<HostResult<void>> {
    await this.launched
    if (this.moving.has(appSessionId)) return hostError('session_unreachable', 'This Chat is moving')
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

    // A closed session leaves the "live" half of the union; it lives on ONLY as a
    // restore-offer, so what it emits turns on whether it is still restorable.
    // Not restorable — no engineSessionId, or (the resume-failed class) an
    // engineSessionId whose transcript does not exist — means neither a tab nor
    // an offer, and a `session-status` would be actively wrong: the renderer
    // folds `restorable === false` back into TAB membership
    // (`app/renderer/src/shellState.ts` foldTabMembership), so a just-closed
    // session would reappear as a live-looking tab. Report it removed.
    const descriptor = this.descriptorFor(appSessionId)
    if (!descriptor || !descriptor.restorable) {
      this.emitRemoved(appSessionId)
    } else {
      // Still restorable — the list projection drops the live entry and picks up
      // the restorable one. A single session-status carries the new
      // (exited, restorable) descriptor.
      this.emit({ type: 'session-status', session: descriptor })
    }
    return { ok: true, value: undefined }
  }

  /* --------------------------------------------------------------------- *
   * setTitle — the P4-6 title-rider's GENERATION half (wired 2026-07-14)
   * --------------------------------------------------------------------- *
   *
   * The sidecar generates an AI session title after a fresh session's first durable input
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
    // restorable — e.g. a clean row that never acquired an engineSessionId, a
    // spawn_failed row marked clean before any ready frame, or a row whose
    // transcript does not exist. Those are not a tab and not a restore, so the
    // descriptor's OWN `restorable` flag is the filter (one predicate, no second
    // copy of it here).
    for (const row of this.registry.restorable()) {
      const descriptor = this.descriptorFromRow(row, null)
      if (!descriptor.restorable) continue
      byId.set(row.appSessionId, descriptor)
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

  isMoving(appSessionId: SessionId): boolean { return this.moving.has(appSessionId) }
  isHiddenMoveWarmup(appSessionId: SessionId): boolean { return this.hiddenMoveWarmups.has(appSessionId) }

  private updateRelocationControls(appSessionId: SessionId, update: Partial<RelocationControls>, replaceSelection = false): void {
    const row = this.registry.findSession(appSessionId)
    if (!row?.engineSessionId) return
    try {
      const record = readSessionRelocation(row.engineSessionId)
      if (record?.phase !== 'complete' || record.appSessionId !== appSessionId || row.cwd !== record.target.cwd) return
      const controls = { ...record.controls, ...update }
      if (replaceSelection) {
        if (!('model' in update)) delete controls.model
        if (!('effort' in update)) delete controls.effort
      }
      if (JSON.stringify(controls) !== JSON.stringify(record.controls)) writeSessionRelocation({ ...record, controls })
    } catch (error) { this.log(`[host] relocation controls could not be saved: ${errText(error)}`) }
  }

  private hasMoveOrigin(engineSessionId: string | null | undefined): boolean {
    try { return !!engineSessionId && readSessionRelocation(engineSessionId)?.phase === 'complete' }
    catch { return false }
  }

  private contextTransitionsFor(row: RegistrySession | undefined): SessionDescriptor['contextTransitions'] {
    if (!row?.engineSessionId) return []
    try {
      const record = readSessionRelocation(row.engineSessionId)
      if (record?.phase !== 'complete' || record.appSessionId !== row.appSessionId ||
          record.target.cwd !== row.cwd) return []
      return (record.transitions ?? []).map(transition => ({
        id: transition.id,
        afterFrameId: transition.afterFrameId,
        cwd: transition.target.cwd,
        binding: transition.target.binding,
      }))
    } catch { return [] }
  }

  private moveRecordBlocked(engineSessionId: string | null | undefined): boolean {
    if (!engineSessionId) return false
    try { return readSessionRelocation(engineSessionId)?.phase === 'moving' }
    catch { return true }
  }

  private restoredRelocationControls(row: RegistrySession): RelocationControls | null {
    if (!row.engineSessionId) return null
    const record = readSessionRelocation(row.engineSessionId)
    return record?.phase === 'complete' && record.appSessionId === row.appSessionId &&
      record.target.cwd === row.cwd && JSON.stringify(record.target.binding) === JSON.stringify(row.binding)
      ? record.controls : null
  }

  private emptyHistoryFile(cwd: string, engineSessionId: string): 'empty' | 'conversation' | 'missing' | 'invalid' {
    const path = defaultTranscriptPath(cwd, engineSessionId)
    try {
      const file = lstatSync(path)
      if (!file.isFile() || file.size > 16 * 1024 * 1024) return 'invalid'
      return readFileSync(path, 'utf8').split('\n').some(line => {
        if (!line) return false
        const entry: unknown = JSON.parse(line)
        return !!entry && typeof entry === 'object' && 'type' in entry &&
          (entry.type === 'user' || entry.type === 'assistant')
      }) ? 'conversation' : 'empty'
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid'
    }
  }

  private isEmptySession(row: RegistrySession): boolean {
    if (!row.engineSessionId || row.hasAcceptedInput === true) return false
    const state = this.emptyHistoryFile(row.cwd, row.engineSessionId)
    return state === 'empty' || (state === 'missing' && row.hasAcceptedInput === false &&
        (row.binding.kind === 'managed' && !!this.managedStorage?.hasSessionIdentity(row.binding, row.appSessionId, row.engineSessionId) ||
          this.restoredRelocationControls(row) !== null))
  }

  private waitForReadyMode(appSessionId: SessionId, controls: RelocationControls): Promise<void> {
    return new Promise((resolve, reject) => {
      const mode = controls.mode
      const readyWithMode = (): boolean => this.supervisor.listSessions().some(item =>
        item.sessionId === appSessionId && item.status === 'ready') &&
        this.permissionModes.get(appSessionId) === mode &&
        (mode !== 'auto' || this.permissionClassifierAvailable.get(appSessionId) === true) &&
        (mode !== 'plan' || !controls.prePlanMode || this.prePlanModes.get(appSessionId) === controls.prePlanMode) &&
        (!controls.fastMode || this.runControls.get(appSessionId)?.fast.active === true ||
          this.runControls.get(appSessionId)?.fast.supportedByModel === false ||
          this.runControls.get(appSessionId)?.fast.available === false)
      const done = (): void => { clearTimeout(timer); unsubscribe() }
      const unsubscribe = this.supervisor.subscribe(event => {
        if (event.sessionId !== appSessionId) return
        if (event.type === 'exit') { done(); reject(mode === 'auto' || (mode === 'plan' && controls.prePlanMode === 'auto') ? autoRestoreRefusal(event.code) ?? new Error('The Chat could not reopen') : new Error('The Chat could not reopen')) }
        else if (readyWithMode()) { done(); resolve() }
      })
      const timer = setTimeout(() => { done(); reject(new Error('The Chat is taking too long to reopen')) }, 60_000)
      // The sidecar can emit both frames before spawn's advisory write returns.
      if (readyWithMode()) { done(); resolve() }
      else if (this.supervisor.listSessions().some(item => item.sessionId === appSessionId &&
        (isTerminalStatus(item.status) || item.status === 'disconnected'))) {
        done(); reject(new Error('The Chat could not reopen'))
      }
    })
  }

  private waitForMoveSourceReady(appSessionId: SessionId): Promise<void> {
    return new Promise((resolve, reject) => {
      const ready = (): boolean => this.supervisor.listSessions().some(item =>
        item.sessionId === appSessionId && item.status === 'ready') &&
        this.registry.findSession(appSessionId)?.engineSessionId !== null &&
        this.runControls.has(appSessionId) && this.permissionModes.has(appSessionId)
      const done = (): void => { clearTimeout(timer); unsubscribe() }
      const unsubscribe = this.supervisor.subscribe(event => {
        if (event.sessionId !== appSessionId) return
        if (event.type === 'exit') { done(); reject(new Error('The Chat could not connect')) }
        else if (ready()) { done(); resolve() }
      })
      const timer = setTimeout(() => { done(); reject(new Error('The Chat is taking too long to connect')) }, 60_000)
      if (ready()) { done(); resolve() }
    })
  }

  private parkForMove(appSessionId: SessionId): Promise<void> {
    return new Promise((resolve, reject) => {
      const unsubscribe = this.supervisor.subscribe(event => {
        if (event.type !== 'exit' || event.sessionId !== appSessionId) return
        clearTimeout(timer); unsubscribe()
        if (event.code === PARKED_EXIT_CODE) resolve()
        else reject(new Error('Chat could not stop cleanly'))
      })
      const timer = setTimeout(() => { unsubscribe(); reject(new Error('Chat is busy; wait for its work to finish')) }, 10_000)
      this.supervisor.send(appSessionId, { type: 'app.park', requestId: randomUUID() })
    })
  }

  private async settleInternalMoveWarmup(appSessionId: SessionId, wasParked: boolean): Promise<void> {
    const record = this.supervisor.listSessions().find(item => item.sessionId === appSessionId)
    try {
      if (record?.status === 'ready') await this.parkForMove(appSessionId)
      else if (record && !isTerminalStatus(record.status)) this.supervisor.killSession(appSessionId)
      if (!wasParked) await this.registry.markClean(appSessionId)
    } catch (error) {
      this.log(`[host] internal move warmup could not stop: ${errText(error)}`)
    }
  }

  /** A routed message is pending work, so unlike a manual closed-Chat move
   * its destination must remain connected until transport can accept input. */
  async prepareRoutedSubmit(appSessionId: SessionId): Promise<void> {
    await this.launched
    if (this.moving.has(appSessionId)) throw new Error('This Chat is moving')
    const live = this.supervisor.listSessions().find(item => item.sessionId === appSessionId)
    if (!live || isTerminalStatus(live.status)) {
      const restored = await this.restoreSession(appSessionId)
      if (!restored.ok) throw new Error(restored.error.message)
    } else if (live.status === 'disconnected') {
      throw new Error('Restart this Chat after its connection was lost')
    }
    await this.waitForMoveSourceReady(appSessionId)
  }

  /** Main supplies a picker-resolved cwd; null returns to the original owned Chat. */
  async moveSession(appSessionId: SessionId, cwd: string | null): Promise<HostResult<SessionDescriptor>> {
    await this.launched
    const row = isUuid(appSessionId) ? this.registry.findSession(appSessionId) : undefined
    if (row?.engineSessionId) {
      try {
        if (readSessionRelocation(row.engineSessionId)?.phase === 'moving') {
          return hostError('session_unreachable', 'This Chat has an unfinished move. Restore its saved backup before reopening it')
        }
      } catch { return hostError('session_unreachable', 'This Chat has an unreadable move record') }
    }
    if (!row || !this.relocate) return hostError('session_not_found', 'This Chat is unavailable')
    if (this.branchSwitching || this.moving.has(appSessionId) || this.restoring.has(appSessionId) || row.createdBy) {
      return hostError('session_unreachable', 'Finish this Chat and its peers before moving it')
    }
    const hasPeerWork = () => {
      const children = this.registry.restorable().filter(other => other.createdBy === appSessionId)
      const liveIds = new Set(this.supervisor.listSessions()
        .filter(item => !isTerminalStatus(item.status)).map(item => item.sessionId))
      const busy = (id: SessionId) => {
        const state = this.peerMoveState?.(id)
        return (state?.pending ?? 0) > 0 || (state?.reservations ?? 0) > 0
      }
      return busy(appSessionId) || children.some(child =>
        busy(child.appSessionId) ||
        (liveIds.has(child.appSessionId) && this.peerMoveState?.(child.appSessionId).presence !== 'idle'))
    }
    if (hasPeerWork()) {
      return hostError('session_unreachable', 'Finish active peer work and deliveries before moving this Chat')
    }
    let target: SessionLocation
    if (cwd === null) {
      let move
      try { move = row.engineSessionId ? readSessionRelocation(row.engineSessionId) : null } catch { /* refusal below */ }
      if (row.binding.kind !== 'project' || !move || move.original.binding.kind !== 'managed' ||
          !row.engineSessionId || !this.managedStorage?.hasSessionIdentity(move.original.binding, appSessionId, row.engineSessionId)) {
        return hostError('session_not_found', 'This conversation has no original Chat folder')
      }
      const original = this.managedStorage.resolve(move.original.binding)
      if (!original.ok || original.cwd !== move.original.cwd) return hostError('managed_storage_missing', 'The original Chat folder is unavailable')
      target = move.original
    } else {
      const validated = this.validateCwd(cwd)
      if (row.binding.kind !== 'managed' || !validated.ok || validated.realpath === row.cwd) {
        return hostError('invalid_cwd', 'Choose a project folder for this Chat')
      }
      target = { cwd: validated.realpath, binding: { kind: 'project' } }
    }
    const source = { cwd: row.cwd, binding: row.binding }
    const live = this.supervisor.listSessions().find(item => item.sessionId === appSessionId)
    if (live?.status === 'disconnected') return hostError('session_unreachable', 'Restart this Chat after its connection was lost')
    const sourceWasInactive = !live || isTerminalStatus(live.status)
    const sourceWasParked = row.shutdown === 'parked'
    const previousSnapshot = this.runControls.get(appSessionId)
    const previousMode = this.permissionModes.get(appSessionId)
    const previousPrePlan = this.prePlanModes.get(appSessionId)
    const previousCandidate = previousSnapshot && previousMode &&
      (previousMode !== 'plan' || previousPrePlan)
      ? { mode: previousMode, model: previousSnapshot.model.selected ?? null,
          ...(previousSnapshot.effort.selected ? { effort: previousSnapshot.effort.selected } : {}),
          fastMode: previousSnapshot.fast.active,
          ...(previousMode === 'plan' ? { prePlanMode: previousPrePlan } : {}) }
      : null
    const previousControls: RelocationControls | null = isRelocationControls(previousCandidate) ? previousCandidate : null
    this.moving.add(appSessionId)
    this.emitStatus(appSessionId)
    if (sourceWasInactive) this.hiddenMoveWarmups.add(appSessionId)
    if (live?.status !== 'ready') {
      try {
        if (sourceWasInactive) {
          this.runControls.delete(appSessionId)
          this.permissionModes.delete(appSessionId)
          this.prePlanModes.delete(appSessionId)
          this.permissionClassifierAvailable.delete(appSessionId)
          if (row.engineSessionId) {
            const restored = await this.restoreSession(appSessionId)
            if (!restored.ok) throw new Error(restored.error.message)
          } else {
            const warmReservation = this.reserveSpawn(true)
            if (!warmReservation.ok) {
              const failed = warmReservation.result
              throw new Error(failed.ok ? 'No session slot available' : failed.error.message)
            }
            const started = await this.spawn({ appSessionId, cwd: row.cwd, binding: row.binding,
              title: row.title, forked: row.forked, resumeEngineSessionId: undefined }, warmReservation)
            if (!started.ok) throw new Error(started.error.message)
          }
        }
        await this.waitForMoveSourceReady(appSessionId)
      } catch (error) {
        if (sourceWasInactive) await this.settleInternalMoveWarmup(appSessionId, sourceWasParked)
        this.hiddenMoveWarmups.delete(appSessionId)
        this.moving.delete(appSessionId)
        this.emitStatus(appSessionId)
        this.peerMoveSettled?.(appSessionId)
        return hostError('session_unreachable', `Could not prepare this Chat to move: ${errText(error)}`)
      }
    } else if (!this.runControls.has(appSessionId) || !this.permissionModes.has(appSessionId)) {
      try { await this.waitForMoveSourceReady(appSessionId) }
      catch (error) {
        this.hiddenMoveWarmups.delete(appSessionId)
        this.moving.delete(appSessionId)
        this.emitStatus(appSessionId)
        this.peerMoveSettled?.(appSessionId)
        return hostError('session_unreachable', `Could not prepare this Chat to move: ${errText(error)}`)
      }
    }
    const movingRow = this.registry.findSession(appSessionId)
    if (!movingRow?.engineSessionId || !this.canResume(appSessionId)) {
      if (sourceWasInactive) await this.settleInternalMoveWarmup(appSessionId, sourceWasParked)
      this.hiddenMoveWarmups.delete(appSessionId)
      this.moving.delete(appSessionId)
      this.emitStatus(appSessionId)
      this.peerMoveSettled?.(appSessionId)
      return hostError('session_unreachable', 'This Chat could not be prepared for a safe move')
    }
    const sourceEmpty = this.isEmptySession(movingRow)
    const snapshot = this.runControls.get(appSessionId)
    const sourceMode = this.permissionModes.get(appSessionId)
    if (!snapshot || !sourceMode) {
      if (sourceWasInactive) await this.settleInternalMoveWarmup(appSessionId, sourceWasParked)
      this.hiddenMoveWarmups.delete(appSessionId); this.moving.delete(appSessionId); this.emitStatus(appSessionId)
      this.peerMoveSettled?.(appSessionId)
      return hostError('session_unreachable', 'Wait for this Chat to finish connecting before moving it')
    }
    if (sourceMode !== 'default' && sourceMode !== 'acceptEdits' && sourceMode !== 'plan' && sourceMode !== 'dontAsk' && sourceMode !== 'auto') {
      if (sourceWasInactive) await this.settleInternalMoveWarmup(appSessionId, sourceWasParked)
      this.hiddenMoveWarmups.delete(appSessionId); this.moving.delete(appSessionId); this.emitStatus(appSessionId)
      this.peerMoveSettled?.(appSessionId)
      return hostError('session_unreachable', 'This permission mode cannot move with the Chat')
    }
    const prePlanMode = this.prePlanModes.get(appSessionId)
    if (sourceMode === 'plan' && prePlanMode !== 'default' && prePlanMode !== 'acceptEdits' &&
        prePlanMode !== 'dontAsk' && prePlanMode !== 'auto') {
      if (sourceWasInactive) await this.settleInternalMoveWarmup(appSessionId, sourceWasParked)
      this.hiddenMoveWarmups.delete(appSessionId); this.moving.delete(appSessionId); this.emitStatus(appSessionId)
      this.peerMoveSettled?.(appSessionId)
      return hostError('session_unreachable', 'Leave Plan before moving this Chat from its current permission mode')
    }
    const controls: RelocationControls = previousControls && sourceWasInactive ? previousControls : {
      mode: sourceMode,
      model: snapshot.model.selected ?? null,
      ...(snapshot.effort.selected ? { effort: snapshot.effort.selected } : {}),
      fastMode: snapshot.fast.active,
      ...(sourceMode === 'plan' ? { prePlanMode: prePlanMode as RelocationControls['prePlanMode'] } : {}),
    }
    // Reserve the replacement before stopping the source. Its live slot is
    // transferred rather than counted twice while the source is still ready.
    const reservation = this.reserveSpawn(true, true)
    if (!reservation.ok) {
      if (sourceWasInactive) await this.settleInternalMoveWarmup(appSessionId, sourceWasParked)
      this.hiddenMoveWarmups.delete(appSessionId)
      this.moving.delete(appSessionId)
      this.emitStatus(appSessionId)
      this.peerMoveSettled?.(appSessionId)
      return reservation.result
    }
    this.moving.add(appSessionId)
    this.restoring.add(appSessionId)
    this.emitStatus(appSessionId)
    let moveReservation: SpawnReservation | null = reservation
    let sourceParked = false
    let moveCommitted = false
    let destinationVerified = false
    let recoveryFailed = false
    let recoveredMoved = false
    let reopenedOriginal = false
    try {
      // Reuse the existing idle gate. A declined park times out without killing work.
      await this.parkForMove(appSessionId)
      sourceParked = true
      if (hasPeerWork()) throw new Error('Finish active peer work and deliveries before moving this Chat')
      await this.relocate({ appSessionId, engineSessionId: movingRow.engineSessionId, source, target, controls })
      const destinationEmpty = readSessionRelocation(movingRow.engineSessionId)?.empty === true
      moveCommitted = true
      await this.registry.updateLocation(appSessionId, target.cwd, target.binding)
      this.evictReplay(appSessionId)
      this.supervisor.killSession(appSessionId)
      this.permissionModes.delete(appSessionId)
      this.prePlanModes.delete(appSessionId)
      this.permissionClassifierAvailable.delete(appSessionId)
      this.runControls.delete(appSessionId)
      // spawn owns the reservation from here, including its failure release.
      moveReservation = null
      const result = await this.spawn({ appSessionId, cwd: target.cwd, binding: target.binding,
        ...(destinationEmpty ? { freshEngineSessionId: movingRow.engineSessionId } : { resumeEngineSessionId: movingRow.engineSessionId }),
        title: row.title, forked: row.forked,
        ...controls,
        permissionMode: controls.mode,
        preferSpawnModel: true,
      }, reservation)
      if (!result.ok) throw new Error(result.error.message)
      await this.waitForReadyMode(appSessionId, controls)
      destinationVerified = true
      if (sourceWasInactive) {
        await this.parkForMove(appSessionId)
        if (!sourceWasParked) await this.registry.markClean(appSessionId)
      }
      return { ok: true, value: this.descriptorFor(appSessionId)! }
    } catch (error) {
      if (moveCommitted && !destinationVerified) {
        try { this.supervisor.killSession(appSessionId); await this.registry.markClean(appSessionId) }
        catch (cleanupError) { this.log(`[host] moved Chat stop failed: ${errText(cleanupError)}`) }
        if (error instanceof AutoRestoreUnavailableError) {
          try {
            await this.relocate({ appSessionId, engineSessionId: movingRow.engineSessionId, source: target, target: source, controls, rollback: true })
            await this.registry.updateLocation(appSessionId, source.cwd, source.binding)
            this.prepareMoveReplayRecovery?.(appSessionId, { persistSourceCache: false })
            const reserved = this.reserveSpawn(true)
            if (!reserved.ok) throw new Error('No session slot available to reopen the original Chat')
            const reopened = await this.spawn({ appSessionId, cwd: source.cwd, binding: source.binding,
              ...(sourceEmpty ? { freshEngineSessionId: movingRow.engineSessionId } : { resumeEngineSessionId: movingRow.engineSessionId }),
              title: row.title, forked: row.forked,
              ...controls, permissionMode: controls.mode, preferSpawnModel: true,
            }, reserved)
            if (!reopened.ok) throw new Error(reopened.error.message)
            await this.waitForReadyMode(appSessionId, controls)
            reopenedOriginal = true
          } catch (reopenError) {
            recoveryFailed = true
            this.log(`[host] original Chat could not reopen after Auto refusal: ${errText(reopenError)}`)
          }
        }
      } else if (sourceParked && !moveCommitted && moveReservation) {
        // A refusal before the durable move record must leave the original Chat
        // open. If mutation began, the record blocks all resume instead.
        try {
          const record = readSessionRelocation(movingRow.engineSessionId)
          if (record?.phase === 'complete' && record.target.cwd === target.cwd &&
              record.appSessionId === appSessionId) {
            // The worker may have finished the atomic publication but lost its
            // result pipe. Reconcile the row so it remains a restore offer.
            await this.registry.updateLocation(appSessionId, target.cwd, target.binding)
            moveCommitted = true
            recoveredMoved = true
          } else if (!record || (record.phase === 'complete' && record.target.cwd === source.cwd)) {
            this.supervisor.killSession(appSessionId)
            this.permissionModes.delete(appSessionId)
            this.prePlanModes.delete(appSessionId)
            this.permissionClassifierAvailable.delete(appSessionId)
            this.runControls.delete(appSessionId)
            this.prepareMoveReplayRecovery?.(appSessionId, { persistSourceCache: true })
            const reserved = moveReservation
            moveReservation = null
            const reopened = await this.spawn({ appSessionId, cwd: source.cwd, binding: source.binding,
              ...(sourceEmpty ? { freshEngineSessionId: movingRow.engineSessionId } : { resumeEngineSessionId: movingRow.engineSessionId }),
              title: row.title, forked: row.forked,
              ...controls, permissionMode: controls.mode,
              preferSpawnModel: true,
            }, reserved)
            if (reopened.ok) {
              await this.waitForReadyMode(appSessionId, controls)
              reopenedOriginal = true
            }
            else recoveryFailed = true
          }
        } catch (reopenError) {
          recoveryFailed = true
          this.log(`[host] original Chat could not reopen: ${errText(reopenError)}`)
        }
      }
      const detail = errText(error)
      if (!reopenedOriginal) this.cancelMoveReplayCoalescing?.(appSessionId)
      this.log(`[host] Chat move failed: ${detail}`)
      const reasons: Array<[string, string]> = [
        ['Open and trust this project', 'Open and trust this project before moving this Chat'],
        ['Leave the worktree', 'Leave the worktree before moving this Chat'],
        ['Finish the scheduled continuation', 'Finish the scheduled continuation before moving this Chat'],
        ['only to its previous project', 'This Chat can currently return only to its previous project'],
        ['still open in another process', 'Close the other process using this Chat before moving it'],
        ['Chat is busy', 'Wait for this Chat to finish before moving it'],
      ]
      const reason = reasons.find(([phrase]) => detail.includes(phrase))?.[1]
      return hostError('session_unreachable', error instanceof AutoRestoreUnavailableError
        ? `${error.message}. ${recoveryFailed ? 'Restore the Chat from the sidebar.' : 'The Chat is back in its original location.'}`
        : recoveryFailed
        ? 'The move failed and the original Chat could not reopen. Restore it from the sidebar.'
        : recoveredMoved ? 'The Chat moved, but could not reopen. Restore it from the sidebar.'
        : reason ?? 'Could not move this Chat. Its saved history is retained.')
    } finally {
      if (sourceWasInactive && this.supervisor.listSessions().some(item => item.sessionId === appSessionId && item.status === 'ready')) {
        try {
          await this.parkForMove(appSessionId)
          if (!sourceWasParked) await this.registry.markClean(appSessionId)
        } catch (error) { this.log(`[host] internal move warmup could not park: ${errText(error)}`) }
      }
      if (moveReservation) this.releaseSpawnReservation(moveReservation)
      this.moving.delete(appSessionId)
      this.peerMoveSettled?.(appSessionId)
      this.restoring.delete(appSessionId)
      this.hiddenMoveWarmups.delete(appSessionId)
      this.emitStatus(appSessionId)
    }
  }

  async restartSession(appSessionId: SessionId): Promise<HostResult<void>> {
    await this.launched
    if (this.moving.has(appSessionId)) return hostError('session_unreachable', 'This Chat is moving')
    if (!isUuid(appSessionId)) {
      return hostError('session_not_found', 'malformed session id')
    }
    const supervisorRecord = this.supervisor
      .listSessions()
      .find(session => session.sessionId === appSessionId)
    if (!supervisorRecord) {
      return hostError('session_not_found', `session ${appSessionId} is not live`)
    }
    const row = this.registry.findSession(appSessionId)
    if (!row) {
      return hostError('session_not_found', `session ${appSessionId} has no registry row`)
    }
    // Re-validate the row's cwd BEFORE anything destructive (HC1 defense in
    // depth, same as `restoreSession`). The supervisor restart KILLS the live
    // child before it respawns, and a stale cwd only surfaces on the fresh
    // child's async error as `failed` — so without this a moved/deleted
    // directory turns a restart into the loss of a healthy sidecar.
    const managed = row.binding.kind === 'managed' ? this.managedStorage?.resolve(row.binding) : undefined
    const validatedCwd = row.binding.kind === 'managed'
      ? (managed?.ok ? { ok: true as const, realpath: managed.cwd } : { ok: false as const, reason: managed?.reason ?? 'invalid' })
      : this.validateCwd(row.cwd)
    if (!validatedCwd.ok) {
      return hostError(row.binding.kind === 'managed'
        ? (managed && !managed.ok && managed.reason === 'missing' ? 'managed_storage_missing' : 'managed_storage_invalid')
        : 'invalid_cwd', `session cwd no longer exists: ${row.cwd}`)
    }
    // §9-A4 (SF6) — the SAME re-check `restoreSession` performs, because this is
    // the other path that hands `resumeEngineSessionId` to a spawn. Without it a
    // restart resumes an id whose transcript never existed (a session opened but
    // never typed in never materializes one — `materializeSessionFile` runs on
    // the first user/assistant message, `src/utils/sessionStorage.ts:1354,1387`)
    // and the sidecar dies `resume-failed`, bumping `restartCount` on every
    // retry. A row with no `engineSessionId` resumes nothing, so it needs no
    // transcript and restarts into blank context exactly as before.
    if (row.engineSessionId !== null && !this.canResume(appSessionId)) {
      return hostError(
        'session_not_found',
        `transcript for ${appSessionId} is gone`,
      )
    }
    const relocationControls = this.restoredRelocationControls(row)
    // A live restart replaces one process, but a terminal supervisor tombstone
    // starts a new one and therefore consumes a live slot.
    const reservation = this.reserveSpawn(isTerminalStatus(supervisorRecord.status))
    if (!reservation.ok) return reservation.result

    // Evict replay BEFORE the restart (mirrors the prior main behavior + P3-0).
    this.evictReplay(appSessionId)
    const creatorName = this.creatorNameFor(row.createdBy, row.createdByName)
    try {
      this.supervisor.restartSession(appSessionId, {
        cwd: validatedCwd.realpath,
        binding: row.binding,
        forked: row.forked,
        recreatedFolderNotice: row.binding.kind === 'managed' &&
          this.managedStorage?.wasRecreated(row.binding) === true,
        ...(row.engineSessionId !== null
          ? this.isEmptySession(row)
            ? { freshEngineSessionId: row.engineSessionId }
            : { resumeEngineSessionId: row.engineSessionId }
          : {}),
        ...(relocationControls ? { ...relocationControls, permissionMode: relocationControls.mode } : {}),
        ...(relocationControls ? { preferSpawnModel: true } : {}),
        // The fresh process must boot with the SAME identity: a restart that
        // dropped the name would leave a live session no peer could address, and
        // one that dropped the creator's LABEL would leave it holding an id it
        // cannot resolve (see `creatorNameFor`).
        ...(row.name !== undefined ? { name: row.name } : {}),
        ...(row.createdBy !== undefined ? { createdBy: row.createdBy } : {}),
        ...(creatorName !== undefined ? { createdByName: creatorName } : {}),
      })
      this.commitSpawnReservation(reservation)
    } catch (error) {
      this.releaseSpawnReservation(reservation)
      return hostError('spawn_failed', `could not restart session: ${errText(error)}`)
    }
    // Refresh advisory fields from the fresh child (new pid + socketPath). The
    // row stays live; upsertOnSpawn bumps restartCount and rewrites the hints.
    await this.registry.upsertOnSpawn({
      appSessionId,
      cwd: row.cwd,
      ...(row.title !== undefined ? { title: row.title } : {}),
      forked: row.forked,
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
   * transcript cache? True ONLY for a session that is NOT live and whose row is
   * restorable — i.e. exactly the descriptor's `restorable` flag, which
   * `isRestorable(row, liveStatus)` already forces false when a process is live.
   * Reusing the descriptor keeps the not-live guard in one place; a LIVE or
   * unknown id returns false, so main never reads a cache off disk for an id the
   * host does not vouch for (the IS-A boundary-test requirement — main-side
   * validation before any disk touch).
   *
   * Derived from THIS id's descriptor rather than from `listSessions()`: the two
   * agree by construction (the union keys on the same `restorable` flag), but
   * `listSessions` now stats one transcript per non-live row, and main's startup
   * cache GC calls this once per cached file (`app/main/main.ts` gcTranscriptCache)
   * — which would have made a one-shot O(rows²) burst of `existsSync` on the
   * Electron main thread.
   */
  canPreview(appSessionId: SessionId): boolean {
    if (!isUuid(appSessionId)) return false
    if (this.moveRecordBlocked(this.registry.findSession(appSessionId)?.engineSessionId)) return false
    return this.registry.hasTranscript(appSessionId) && this.descriptorFor(appSessionId)?.restorable === true
  }

  /**
   * IDLE-PARK §1c — a live engine is a valid park candidate only when its
   * transcript can be resumed after reclamation. This deliberately does not
   * apply the not-live requirement of `canPreview`: the driver asks before the
   * sidecar exits.
   */
  canResume(appSessionId: SessionId): boolean {
    if (!isUuid(appSessionId)) return false
    if (this.resumeFailed.has(appSessionId)) return false
    const row = this.registry.findSession(appSessionId)
    try {
      const move = row?.engineSessionId ? readSessionRelocation(row.engineSessionId) : null
      if (move && (move.phase === 'moving' || move.appSessionId !== appSessionId ||
          row?.cwd !== move.target.cwd || JSON.stringify(row.binding) !== JSON.stringify(move.target.binding))) return false
    } catch { return false }
    if (row?.binding.kind === 'managed' && row.engineSessionId !== null &&
      !this.managedStorage?.hasSessionIdentity(row.binding, appSessionId, row.engineSessionId)) return false
    return this.registry.hasTranscript(appSessionId) || (row !== undefined && this.isEmptySession(row))
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

  /** Hold all new spawns while a checkout moves the files under live sessions. */
  beginBranchSwitch(): boolean {
    if (this.branchSwitching || this.pendingSpawns > 0 || this.moving.size > 0) return false
    this.branchSwitching = true
    return true
  }

  endBranchSwitch(): void {
    this.branchSwitching = false
  }

  private reserveSpawn(consumesLive: boolean, replacesLive = false):
    | { ok: true; token: string; consumesLive: boolean }
    | { ok: false; result: HostResult<never> } {
    if (this.branchSwitching) {
      return { ok: false, result: hostError('branch_unavailable', 'A branch switch is in progress. Try again shortly.') }
    }
    // Concurrency bound: live engine processes. Deliberately NOT the registry's
    // row bound (`MAX_REGISTRY_SESSIONS`) — that one covers live + terminal rows
    // and is a file-growth backstop, so tying process concurrency to it meant
    // raising the row bound would raise the fork-bomb cap too. The reap only
    // trims TERMINAL rows; live rows are never evicted to make room.
    if (consumesLive && this.liveCount() + this.pendingLiveSlots - (replacesLive ? 1 : 0) >= MAX_LIVE_SESSIONS) {
      return { ok: false, result: hostError('session_limit', `at most ${MAX_LIVE_SESSIONS} live sessions`) }
    }
    const now = this.now()
    // A wall-clock rollback must open a fresh bounded window rather than retain
    // future timestamps indefinitely.
    if (this.spawnTimes.some(entry => entry.timestamp > now)) {
      this.spawnTimes = []
    } else {
      const cutoff = now - SPAWN_RATE_WINDOW_MS
      this.spawnTimes = this.spawnTimes.filter(entry => entry.timestamp > cutoff)
    }
    if (this.spawnTimes.length >= MAX_SPAWNS_PER_WINDOW) {
      return { ok: false, result: hostError(
        'session_limit',
        `spawn rate cap: ${MAX_SPAWNS_PER_WINDOW} per ${SPAWN_RATE_WINDOW_MS}ms`,
      ) }
    }
    const reservation = { ok: true as const, token: randomUUID(), consumesLive }
    this.spawnTimes.push({ token: reservation.token, timestamp: now })
    this.pendingSpawns += 1
    if (consumesLive) this.pendingLiveSlots += 1
    return reservation
  }

  private commitSpawnReservation(reservation: SpawnReservation): void {
    this.pendingSpawns -= 1
    if (reservation.consumesLive) this.pendingLiveSlots -= 1
  }

  private releaseSpawnReservation(reservation: SpawnReservation): void {
    this.pendingSpawns -= 1
    if (reservation.consumesLive) this.pendingLiveSlots -= 1
    this.spawnTimes = this.spawnTimes.filter(entry => entry.token !== reservation.token)
  }

  private liveCount(): number {
    return this.supervisor
      .listSessions()
      .filter(session => !isTerminalStatus(session.status)).length
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
      binding: row?.binding ?? { kind: 'project' },
      moving: row ? this.moving.has(row.appSessionId) : false,
      canMoveBack: row?.binding.kind === 'project' && this.hasMoveOrigin(row.engineSessionId),
      contextTransitions: this.contextTransitionsFor(row),
      title: row?.title ?? null,
      // PEER-SESSIONS §2/§6. null ⇒ a row that predates the field and has not
      // been spawned since; false ⇒ the user has not blocked peer wake here.
      name: row?.binding.kind === 'managed' ? null : (row?.name ?? null),
      // The creator's ID, never a resolved name: a name baked in here would
      // outlive the row it came from and later point at a different session.
      createdBy: row?.createdBy ?? null,
      peerWakeBlocked: row?.peerWakeBlocked === true,
      forked: row?.forked ?? false,
      // null ⇒ the app never recorded a title intent for this row, so the
      // renderer lets a real transcript title win (the terminal-rename fix).
      titleUpdatedAt: row?.titleUpdatedAt ?? null,
      status,
      restorable: this.isRestorable(row, liveStatus),
      // IDLE-PARK §1b — the one bit `status` cannot carry, read off the same
      // row marking the status branch above already tests. Gated on there being
      // no live process: `upsertOnSpawn` clears `shutdown` on restore, but a
      // descriptor built mid-spawn would otherwise still read the stale mark and
      // paint a booting engine as resting.
      parked: liveStatus === null && row?.shutdown === 'parked',
      createdAt: row?.createdAt ?? 0,
      lastAttachedAt: row?.lastAttachedAt ?? 0,
      // CC-2: the sidebar reads this for its recency text; null → the row falls
      // back to `createdAt`, never to `lastAttachedAt` (the bug this fixes).
      lastMessageSentAt: row?.lastMessageSentAt ?? null,
    }
  }

  /**
   * A session is restorable when a registry row exists with a known
   * engineSessionId (transcript key), that transcript EXISTS RIGHT NOW, and no
   * process is currently live for it. `restorable` means "registry row +
   * transcript both present (the row can be re-spawned)"
   * (app/shared/hostApi.ts, REGISTRY.md §6.1) — a LIVE session is never a
   * restore candidate (restoreSession rejects an already-live id), so
   * `liveStatus != null` forces `false`.
   *
   * The transcript check is READ-TIME, not launch-time. This method used to
   * assume "the launch reap already dropped rows whose transcript is gone", but
   * that holds only ACROSS launches: `fillEngineSessionId` stamps the id from
   * the ready frame (`onSupervisorEvent`), i.e. at SPAWN, while the engine only
   * materializes the `.jsonl` on the first user/assistant message
   * (`src/utils/sessionStorage.ts:1354,1387`). Every session opened and never
   * typed in therefore holds a non-null `engineSessionId` pointing at a file
   * that does not exist, and nothing re-checked it for the rest of the run — so
   * the descriptor claimed restorable and the sidecar died `resume-failed` on
   * click. `hasTranscript` is the registry's existing §9-A4 re-check (the one
   * `restoreSession` already trusts) and also covers a transcript pruned
   * mid-run.
   */
  private isRestorable(
    row: RegistrySession | undefined,
    liveStatus: SidecarStatus | null,
  ): boolean {
    if (liveStatus !== null) return false
    if (!row) return false
    if (row.engineSessionId === null) return row.binding.kind === 'managed' && this.hasPendingSubmit(row.appSessionId)
    // Keep an interrupted move visible as a recovery row. The restore owner
    // refuses it above, and preview remains closed, so no half-moved bytes are
    // consumed while the user can still find the saved conversation.
    if (this.moveRecordBlocked(row.engineSessionId)) return true
    return this.canResume(row.appSessionId)
  }

  /**
   * May this row's `engineSessionId` be handed to a spawn as a resume — and
   * therefore be ADVERTISED as one? The single rule behind `isRestorable`,
   * `restoreSession` and `restartSession`, so the descriptor can never promise a
   * restore the spawn paths would refuse (that split is what let the sidebar
   * offer sessions that died `resume-failed` on click).
   *
   * Two signals, both read-time:
   *  - `hasTranscript` — the registry's §9-A4 re-check (`registry.ts` filePath
   *    encoding + `existsSync`). Catches the never-materialized row and the
   *    pruned-since-launch row.
   *  - `resumeFailed` — the engine's own verdict from a prior attempt this run.
   *    A transcript FILE can exist and still carry no loadable conversation
   *    (`app/sidecar/sessionResume.ts` "no conversation found"); `existsSync`
   *    cannot see that, only the sidecar's exit code reports it.
   */
  /* --------------------------------------------------------------------- *
   * HostEvent emit helpers
   * --------------------------------------------------------------------- */

  private emit(event: HostEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  private emitStatus(appSessionId: SessionId): void {
    if (this.hiddenMoveWarmups.has(appSessionId)) return
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
