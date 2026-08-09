/**
 * Sidecar supervisor — the window-independent host module (D6 pin 2 /
 * DIRECTION-REVIEW DR-1).
 *
 * This module has ZERO `electron` imports. It is a plain Node module that
 * Electron main *calls*; the window is client #1 of its spawn/attach/registry
 * API, not its owner. That is what turns the eventual always-on milestone
 * (GOAL_PLAN.md:75) into an *attach* against this same host module rather than a
 * Phase-3 rewrite — a daemon (or a phone) can drive the same API.
 *
 * It uses Node's `child_process` (not `Bun.spawn`), because Electron main runs
 * under Node, not Bun. The child it spawns IS Bun (the engine sidecar).
 *
 * Structured for N sessions from the start (P0-4 N-process verdict): the
 * registry is a `Map<sessionId, SidecarRecord>`. P1-0 spawns exactly one, but
 * adding the Nth is a `.set`, not a rewrite.
 *
 * The IPC channel is a Unix-domain socket (D6 pin 1) — a socket FILE, not stdio
 * and not a child-IPC pipe (both parent-bound). The supervisor allocates the
 * socket path, tells the sidecar where to bind (env), and connects to it.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { connect, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { encodeFrame, FrameDecoder } from '../shared/framing.js'
import {
  MAX_FRAME_BYTES,
  MAX_OUTBOUND_FRAME_BYTES,
  MAX_PROMPT_BYTES,
} from '../shared/limits.js'
import {
  PROTOCOL_VERSION,
  type ClientFrame,
  type ReadyFrame,
  type ServerFrame,
  type SessionId,
  type SidecarClientMessage,
} from '../shared/protocol.js'

export type SupervisorOptions = {
  /**
   * Grace period before a closed socket is reported as `disconnected`, so an
   * ordinary process exit is not first announced as a transport failure
   * (`reportSocketLoss`). Defaults to 250 ms; tests inject a small value.
   */
  disconnectSettleMs?: number
  /**
   * How to launch the sidecar. In dev this is `bun run <sidecar entry>`; in a
   * packaged app it is the `--compile`d standalone binary. Injected so the
   * supervisor stays runtime-agnostic and testable.
   */
  sidecarCommand: string
  sidecarArgs?: string[]
  /** Extra env for the sidecar (e.g. the P1-0 probe flag). */
  sidecarEnv?: Record<string, string>
  /**
   * Boot cwd for the sidecar. This must match the session-config cwd because
   * engine project identity is initialized from process.cwd().
   */
  sidecarCwd?: string
  /**
   * Directory for per-session socket files. Defaults to a private random temp
   * dir; callers supplying one own its access-control policy.
   */
  socketDir?: string
  /** Structured logger. */
  log?: (line: string) => void
}

/** Lifecycle state of a managed sidecar. */
export type SidecarStatus =
  | 'spawning'
  | 'connecting'
  | 'ready'
  | 'disconnected' // socket closed but child may still be alive (F13)
  | 'failed' // launch/connect failed; not usable (F7/F12)
  | 'exited'

/** One managed sidecar. The registry maps sessionId → this. */
type SidecarRecord = {
  sessionId: SessionId
  child: ChildProcess
  socketPath: string
  socket: Socket | null
  decoder: FrameDecoder
  status: SidecarStatus
  /** Spawn config to re-apply on restart (per-session cwd + resume id). */
  config?: SpawnConfig
}

export type SupervisorEvent =
  | { type: 'frame'; sessionId: SessionId; frame: ServerFrame }
  | { type: 'status'; sessionId: SessionId; status: SidecarStatus }
  | { type: 'exit'; sessionId: SessionId; code: number | null; signal: string | null }

/**
 * Per-session spawn config (REGISTRY.md §6.1 / §7 item 2). Handed to the sidecar
 * via env — `CATCODE_SIDECAR_CWD` and the optional
 * `CATCODE_SIDECAR_RESUME_SESSION_ID` — exactly like the P1-0
 * `CATCODE_SIDECAR_SESSION_ID` env. This is **main/host-owned input, never
 * renderer input** (SECURITY-MINIMUM T8/HC1): validation-at-API is P3-3's job,
 * but the sidecar still fail-closes on a missing/non-directory cwd.
 */
export type SpawnConfig = {
  /**
   * Session root. Also becomes the child process's actual spawn cwd, because the
   * engine derives project identity from `process.cwd()` at boot
   * (`src/bootstrap/state.ts` getInitialState → `originalCwd`/`projectRoot`).
   */
  cwd: string
  /**
   * When present, session construction resumes THIS engine session through the
   * engine's real resume machinery (not a fresh mint) — REGISTRY.md R3. The
   * sidecar's ready frame then echoes this id as `engineSessionId`.
   */
  resumeEngineSessionId?: string
}

export type SendFailureCode =
  | 'session_not_found'
  | 'session_not_ready'
  | 'session_disconnected'

export class SidecarSendError extends Error {
  readonly code: SendFailureCode
  readonly retryable: boolean

  constructor(code: SendFailureCode, message: string) {
    super(message)
    this.name = 'SidecarSendError'
    this.code = code
    this.retryable = code === 'session_not_ready'
  }
}

export function isSidecarSendError(error: unknown): error is SidecarSendError {
  return error instanceof SidecarSendError
}

export class SidecarSupervisor {
  private readonly registry = new Map<SessionId, SidecarRecord>()
  private readonly listeners = new Set<(event: SupervisorEvent) => void>()
  private readonly options: Required<Pick<SupervisorOptions, 'sidecarCommand'>> &
    SupervisorOptions
  private readonly socketDir: string
  private readonly log: (line: string) => void

  /** Monotonic counter → short, collision-free socket filenames. */
  private socketSeq = 0

  /**
   * Terminal once `shutdown()` has run. A supervisor is never reused after
   * teardown (main nulls it and `ensureHost` builds a fresh one on reactivate),
   * so this only ever catches a spawn that was ALREADY IN FLIGHT when the window
   * closed — the fire-and-forget primary-session create, which awaits the
   * registry launch gate and can resume after `shutdownAll()`. Without it that
   * continuation spawns an unreachable sidecar into a torn-down supervisor,
   * outliving the window it was supposed to die with (D6).
   */
  private closed = false

  /**
   * Pending `reportSocketLoss` settles. Held so teardown can drop them: a timer
   * that fired after `shutdown()` would emit a `disconnected` for a session the
   * supervisor no longer manages.
   */
  private readonly disconnectTimers = new Set<ReturnType<typeof setTimeout>>()

  /**
   * How long a socket close waits to see whether the child was simply exiting
   * (`reportSocketLoss`). Long enough to cover the observed few-millisecond gap
   * between FIN and reap with headroom, short enough that a genuine drop with a
   * living child is still reported promptly. Injectable so tests need no wall
   * clock.
   */
  private readonly disconnectSettleMs: number

  constructor(options: SupervisorOptions) {
    this.options = options
    this.disconnectSettleMs = options.disconnectSettleMs ?? 250
    // A Unix-domain socket path is bounded by the platform's `sun_path` (104
    // bytes on Darwin, 108 on Linux). The macOS `$TMPDIR` (/var/folders/…) plus
    // a UUID filename overflows it, so use a short random `/tmp/cc-*` directory
    // and short per-session filenames. The old predictable PID directory was
    // pre-creatable by another local user, turning its socket into an unauthenticated
    // control channel. The registry still keys sessions by the real sessionId;
    // the socket name is an internal handle only.
    if (options.socketDir) {
      // This is an explicit host/test override. Never chmod an existing caller
      // path here: it could be a shared directory such as `/tmp`.
      this.socketDir = options.socketDir
      if (!existsSync(this.socketDir)) {
        mkdirSync(this.socketDir, { recursive: true, mode: 0o700 })
      }
    } else {
      this.socketDir = createPrivateSocketDir()
    }
    this.log = options.log ?? (line => process.stderr.write(`${line}\n`))
  }

  /** Max Unix-domain socket path length (`sun_path`) for this platform. */
  private get maxSocketPathBytes(): number {
    return process.platform === 'linux' ? 108 : 104
  }

  /** Subscribe to all supervisor events (frames, status, exits). */
  subscribe(listener: (event: SupervisorEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Spawn a new sidecar for a session and connect to its socket. Returns once
   * the child is launched; readiness is signalled asynchronously via a `status`
   * event (and the sidecar's own `app.ready` frame).
   *
   * `config` (REGISTRY.md §7 item 2): the caller-chosen working directory and an
   * optional engine session to resume. Absent (P1-0/probe callers), the
   * supervisor's `sidecarCwd` option is used and no resume is requested.
   */
  spawnSession(sessionId: SessionId = randomUUID(), config?: SpawnConfig): SessionId {
    // Throwing (rather than returning) matches the other refusals here; the
    // host's spawn already converts a synchronous throw into a typed
    // `spawn_failed` and cleans up the row it just wrote (`host.ts` spawn).
    if (this.closed) {
      throw new Error('supervisor has shut down; refusing to spawn')
    }
    if (this.registry.has(sessionId)) {
      throw new Error(`session ${sessionId} already exists`)
    }
    // Per-session cwd wins over the supervisor-wide default; it must be both the
    // child's spawn cwd AND the env the sidecar validates, because the engine's
    // project identity is initialized from process.cwd() at boot.
    const spawnCwd = config?.cwd ?? this.options.sidecarCwd

    // Short internal socket filename (not the UUID sessionId) to stay under the
    // platform `sun_path` limit. Fail loudly here if it would overflow rather
    // than let the sidecar throw a cryptic "Failed to listen".
    const socketPath = join(this.socketDir, `s${this.socketSeq++}.sock`)
    if (Buffer.byteLength(socketPath) >= this.maxSocketPathBytes) {
      throw new Error(
        `socket path too long (${Buffer.byteLength(socketPath)} ≥ ${this.maxSocketPathBytes}): ${socketPath}. ` +
          'Pass a shorter socketDir.',
      )
    }
    // A stale socket file from a crashed prior run would block bind.
    if (existsSync(socketPath)) {
      rmSync(socketPath, { force: true })
    }

    const child = spawn(this.options.sidecarCommand, this.options.sidecarArgs ?? [], {
      stdio: ['ignore', 'inherit', 'inherit'],
      // Actual spawn cwd: the engine reads process.cwd() at boot for project
      // identity (src/bootstrap/state.ts getInitialState → originalCwd), so the
      // child must actually start here — the env alone is not enough.
      cwd: spawnCwd,
      env: {
        ...process.env,
        ...this.options.sidecarEnv,
        CATCODE_SIDECAR_SOCKET: socketPath,
        CATCODE_SIDECAR_SESSION_ID: sessionId,
        // Host-owned inputs (T8/HC1). Only set the cwd env when we have one so
        // the sidecar's own missing-cwd guard still fires for misconfigured
        // callers. The resume id rides env only when a resume was requested.
        ...(spawnCwd !== undefined ? { CATCODE_SIDECAR_CWD: spawnCwd } : {}),
        ...(config?.resumeEngineSessionId !== undefined
          ? { CATCODE_SIDECAR_RESUME_SESSION_ID: config.resumeEngineSessionId }
          : { CATCODE_SIDECAR_RESUME_SESSION_ID: '' }),
      },
    })

    const record: SidecarRecord = {
      sessionId,
      child,
      socketPath,
      socket: null,
      // Outbound = trusted engine output; use the large sanity cap so a big but
      // valid SDK event (image/tool result) is not rejected (F3).
      decoder: new FrameDecoder(MAX_OUTBOUND_FRAME_BYTES),
      status: 'spawning',
      // Retained so restartSession re-roots the fresh engine process in the same
      // cwd and re-resumes the same engine session (REGISTRY.md §2: a restarted
      // engine re-announces its engineSessionId in its new ready frame).
      ...(config ? { config } : {}),
    }
    this.registry.set(sessionId, record)

    // F7 — a spawn error (e.g. ENOENT: bun not on PATH, missing packaged binary)
    // emits an 'error' event; without a listener Node treats it as unhandled and
    // can terminate Electron main. Handle it as a session failure instead.
    child.on('error', error => {
      this.log(`[supervisor] sidecar ${sessionId} spawn error: ${error.message}`)
      this.setStatus(record, 'failed')
    })

    child.on('exit', (code, signal) => {
      // F11 — only report the exit if this record is still the registered one.
      // After a restart, the OLD child's async exit must not mark the live
      // replacement dead.
      if (this.registry.get(sessionId) !== record) {
        return
      }
      this.emit({ type: 'exit', sessionId, code, signal })
      this.setStatus(record, 'exited')
      // Crash isolation: one sidecar dying does not touch the others. Restart
      // is left to the caller's policy (the app owns restart cadence).
    })

    // The sidecar creates the socket file after it boots; poll-connect until it
    // exists, then attach.
    this.connectWhenReady(record)
    return sessionId
  }

  /** Emit a status change only if it actually changed and the record is current. */
  private setStatus(record: SidecarRecord, status: SidecarStatus): void {
    if (this.registry.get(record.sessionId) !== record) return
    if (record.status === status) return
    record.status = status
    this.emit({ type: 'status', sessionId: record.sessionId, status })
  }

  /** Send an allowlisted client message to a session's sidecar. */
  send(sessionId: SessionId, message: SidecarClientMessage): void {
    const record = this.registry.get(sessionId)
    if (!record) {
      throw new SidecarSendError(
        'session_not_found',
        `session ${sessionId} was not found`,
      )
    }
    if (!record.socket || record.status !== 'ready') {
      const code = sendFailureCodeForStatus(record.status)
      throw new SidecarSendError(code, `session ${sessionId} is ${record.status}`)
    }
    const frame: ClientFrame = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId,
      message,
    }
    if (
      message.type === 'app.submit' &&
      Buffer.byteLength(message.prompt, 'utf8') > MAX_PROMPT_BYTES
    ) {
      throw new Error(`prompt exceeds ${MAX_PROMPT_BYTES} bytes`)
    }
    const encoded = encodeFrame(frame)
    const payloadBytes = encoded.byteLength - 4
    if (payloadBytes > MAX_FRAME_BYTES) {
      throw new Error(`frame exceeds ${MAX_FRAME_BYTES} bytes`)
    }
    record.socket.write(encoded)
  }

  /** Kill and deregister one session's sidecar. */
  killSession(sessionId: SessionId): void {
    const record = this.registry.get(sessionId)
    if (!record) return
    record.socket?.destroy()
    record.child.kill('SIGTERM')
    this.cleanupSocketFile(record)
    this.registry.delete(sessionId)
  }

  /** Restart a session's sidecar in place (fresh process = fresh STATE singleton). */
  restartSession(sessionId: SessionId, configOverride?: SpawnConfig): void {
    const record = this.registry.get(sessionId)
    if (!record) {
      throw new Error(`session ${sessionId} does not exist`)
    }
    const config = configOverride ?? record.config
    this.killSession(sessionId)
    // Re-apply the same spawn config so the fresh process re-roots in the same
    // cwd and re-resumes the same engine session.
    this.spawnSession(sessionId, config)
  }

  /** Kill every sidecar and clear the registry. Terminal: no further spawns. */
  shutdown(): void {
    this.closed = true
    for (const timer of this.disconnectTimers) clearTimeout(timer)
    this.disconnectTimers.clear()
    for (const sessionId of [...this.registry.keys()]) {
      this.killSession(sessionId)
    }
    try {
      rmSync(this.socketDir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }

  /** Snapshot of the current registry (for a future durable registry / UI). */
  listSessions(): Array<{ sessionId: SessionId; status: SidecarRecord['status'] }> {
    return [...this.registry.values()].map(record => ({
      sessionId: record.sessionId,
      status: record.status,
    }))
  }

  /** Advisory process id for crash/liveness probes; not a routing identity. */
  getSessionProcessId(sessionId: SessionId): number | undefined {
    return this.registry.get(sessionId)?.child.pid
  }

  /**
   * Advisory socket path for a live session — the registry persists it as the
   * §9-A3 orphan-identity signal and the v2 re-attach seed (REGISTRY.md R2). A
   * cleanup/identity hint only, never a routing identity (routing is the
   * in-memory map). Undefined once the session is killed/deregistered.
   */
  getSessionSocketPath(sessionId: SessionId): string | undefined {
    return this.registry.get(sessionId)?.socketPath
  }

  /* --------------------------------------------------------------------- */

  private connectWhenReady(record: SidecarRecord, attempt = 0): void {
    const MAX_ATTEMPTS = 200 // ~10s at 50ms
    if (this.registry.get(record.sessionId) !== record) {
      return // session was killed/replaced while we were waiting
    }
    if (record.status === 'exited' || record.status === 'failed') {
      return
    }

    if (!existsSync(record.socketPath)) {
      if (attempt >= MAX_ATTEMPTS) {
        // F12 — do not silently abandon a slow/hung sidecar. Mark it failed,
        // kill the orphaned child, and surface the state so the app can retry.
        this.log(
          `[supervisor] sidecar ${record.sessionId} never created its socket; marking failed and killing child`,
        )
        record.child.kill('SIGTERM')
        this.setStatus(record, 'failed')
        return
      }
      setTimeout(() => this.connectWhenReady(record, attempt + 1), 50)
      return
    }

    this.setStatus(record, 'connecting')

    // Keep the local writable half open until the explicit `end` handler runs.
    // This makes remote FIN observable rather than relying on an implicit close.
    const socket = connect({ path: record.socketPath, allowHalfOpen: true })
    record.socket = socket

    socket.on('connect', () => {
      this.setStatus(record, 'connecting')
    })

    socket.on('data', chunk => {
      const results = record.decoder.push(chunk)
      for (const result of results) {
        if (result.kind === 'error') {
          this.log(`[supervisor] frame decode error from ${record.sessionId}: ${result.reason}`)
          socket.destroy()
          return
        }
        const frame = result.payload
        if (!isObjectRecord(frame)) {
          this.log(
            `[supervisor] dropped frame from ${record.sessionId}: frame was not an object`,
          )
          continue
        }
        const serverFrame = frame as ServerFrame
        if (serverFrame.kind === 'ready') {
          const readyError = validateReadyFrame(record.sessionId, serverFrame)
          if (readyError) {
            this.log(
              `[supervisor] invalid ready frame from ${record.sessionId}: ${readyError}`,
            )
            this.setStatus(record, 'failed')
            socket.destroy()
            return
          }
          this.setStatus(record, 'ready')
          this.emit({
            type: 'frame',
            sessionId: record.sessionId,
            frame: serverFrame,
          })
          continue
        }

        if (serverFrame.sessionId !== record.sessionId) {
          this.log(
            `[supervisor] dropped frame from ${record.sessionId}: frame sessionId ${String(
              serverFrame.sessionId,
            )} did not match connection`,
          )
          continue
        }
        if (record.status !== 'ready') {
          this.log(
            `[supervisor] dropped ${String(serverFrame.kind)} frame from ${record.sessionId} before a valid ready frame`,
          )
          this.setStatus(record, 'failed')
          socket.destroy()
          return
        }
        this.emit({
          type: 'frame',
          sessionId: record.sessionId,
          frame: serverFrame,
        })
      }
    })

    socket.on('error', error => {
      this.log(`[supervisor] socket error for ${record.sessionId}: ${error.message}`)
    })

    socket.on('end', () => {
      if (record.socket !== socket) {
        return
      }
      record.socket = null
      this.reportSocketLoss(record)
      socket.destroy()
    })

    socket.on('close', () => {
      if (record.socket !== socket) {
        return // a newer socket already replaced this one
      }
      record.socket = null
      this.reportSocketLoss(record)
    })
  }

  /**
   * F13 — the socket closed. Do NOT keep reporting 'ready'. If the child is gone
   * the 'exit' handler will move to 'exited'; otherwise reflect the disconnected
   * state so a UI/policy can react.
   *
   * SETTLED, not immediate, because a socket close and a process death are the
   * same event seen twice. A dying child FINs first and is reaped a few
   * milliseconds later (measured ~7 ms for an idle-park self-exit), so reporting
   * `disconnected` synchronously announced a transport FAILURE for every ordinary
   * process exit, and consumers that classify on the exit CODE then had to
   * overwrite it. Downstream that read as a crash: an intentional idle-park
   * flashed "This session lost its connection" and a Restart button before
   * settling (IDLE-PARK.md §1a).
   *
   * `record.socket` is cleared SYNCHRONOUSLY above, so `send` still fails fast
   * during the settle window — only the status EVENT waits. If the child really
   * is gone, `child.on('exit')` moves the record to `'exited'` inside the window
   * and the re-check below drops the redundant event; a genuine drop with a
   * living child still reports, one settle-interval later.
   */
  private reportSocketLoss(record: SidecarRecord): void {
    if (record.status !== 'ready' && record.status !== 'connecting') return
    const timer = setTimeout(() => {
      this.disconnectTimers.delete(timer)
      // Re-checked at fire time: the record may have been replaced, killed, or
      // already moved to a terminal state by the exit this close belonged to.
      if (this.registry.get(record.sessionId) !== record) return
      if (record.status !== 'ready' && record.status !== 'connecting') return
      this.setStatus(record, 'disconnected')
    }, this.disconnectSettleMs)
    timer.unref?.()
    this.disconnectTimers.add(timer)
  }

  private cleanupSocketFile(record: SidecarRecord): void {
    try {
      if (existsSync(record.socketPath)) {
        rmSync(record.socketPath, { force: true })
      }
    } catch {
      // best-effort
    }
  }

  private emit(event: SupervisorEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}

export function createPrivateSocketDir(): string {
  if (process.platform === 'win32') {
    return join(process.env.TEMP ?? 'C:\\Temp', `catcode-${process.pid}`)
  }
  const dir = mkdtempSync('/tmp/cc-')
  chmodSync(dir, 0o700)
  return dir
}

function sendFailureCodeForStatus(status: SidecarStatus): SendFailureCode {
  if (status === 'spawning' || status === 'connecting') return 'session_not_ready'
  return 'session_disconnected'
}

function validateReadyFrame(
  sessionId: SessionId,
  frame: ServerFrame,
): string | null {
  const ready = frame as ReadyFrame
  if (ready.protocolVersion !== PROTOCOL_VERSION) {
    return 'missing or wrong protocolVersion'
  }
  if (ready.sessionId !== sessionId || typeof ready.sessionId !== 'string') {
    return 'sessionId does not match supervisor record'
  }
  if (
    typeof ready.engineSessionId !== 'string' ||
    ready.engineSessionId.length === 0
  ) {
    return 'missing engineSessionId'
  }
  if (
    !isObjectRecord(ready.payload) ||
    ready.payload.type !== 'app.ready'
  ) {
    return 'payload is not app.ready'
  }
  return null
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
