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
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { encodeFrame, FrameDecoder } from '../shared/framing.js'
import { MAX_OUTBOUND_FRAME_BYTES } from '../shared/limits.js'
import {
  PROTOCOL_VERSION,
  type ClientFrame,
  type ServerFrame,
  type SessionId,
} from '../shared/protocol.js'
import type { AppClientMessage } from '@cat-code/engine/session-events'

export type SupervisorOptions = {
  /**
   * How to launch the sidecar. In dev this is `bun run <sidecar entry>`; in a
   * packaged app it is the `--compile`d standalone binary. Injected so the
   * supervisor stays runtime-agnostic and testable.
   */
  sidecarCommand: string
  sidecarArgs?: string[]
  /** Extra env for the sidecar (e.g. the P1-0 probe flag). */
  sidecarEnv?: Record<string, string>
  /** Directory for the per-session socket files. Defaults to an OS temp dir. */
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
  restartCount: number
}

export type SupervisorEvent =
  | { type: 'frame'; sessionId: SessionId; frame: ServerFrame }
  | { type: 'status'; sessionId: SessionId; status: SidecarStatus }
  | { type: 'exit'; sessionId: SessionId; code: number | null; signal: string | null }

export class SidecarSupervisor {
  private readonly registry = new Map<SessionId, SidecarRecord>()
  private readonly listeners = new Set<(event: SupervisorEvent) => void>()
  private readonly options: Required<Pick<SupervisorOptions, 'sidecarCommand'>> &
    SupervisorOptions
  private readonly socketDir: string
  private readonly log: (line: string) => void

  /** Monotonic counter → short, collision-free socket filenames. */
  private socketSeq = 0

  constructor(options: SupervisorOptions) {
    this.options = options
    // A Unix-domain socket path is bounded by the platform's `sun_path` (104
    // bytes on Darwin, 108 on Linux). The macOS `$TMPDIR` (/var/folders/…) plus
    // a UUID filename overflows it, so default to a SHORT base and use short
    // per-session filenames (a counter, not the UUID sessionId). The registry
    // still keys sessions by the real sessionId; the socket name is an internal
    // handle only.
    this.socketDir =
      options.socketDir ??
      (process.platform === 'win32'
        ? join(process.env.TEMP ?? 'C:\\Temp', `catcode-${process.pid}`)
        : `/tmp/catcode-${process.pid}`)
    this.log = options.log ?? (line => process.stderr.write(`${line}\n`))
    if (!existsSync(this.socketDir)) {
      mkdirSync(this.socketDir, { recursive: true })
    }
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
   */
  spawnSession(sessionId: SessionId = randomUUID()): SessionId {
    if (this.registry.has(sessionId)) {
      throw new Error(`session ${sessionId} already exists`)
    }

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
      env: {
        ...process.env,
        ...this.options.sidecarEnv,
        CATCODE_SIDECAR_SOCKET: socketPath,
        CATCODE_SIDECAR_SESSION_ID: sessionId,
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
      restartCount: 0,
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
  send(sessionId: SessionId, message: AppClientMessage): void {
    const record = this.registry.get(sessionId)
    if (!record || !record.socket || record.status !== 'ready') {
      throw new Error(`session ${sessionId} is not connected`)
    }
    const frame: ClientFrame = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId,
      message,
    }
    record.socket.write(encodeFrame(frame))
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
  restartSession(sessionId: SessionId): void {
    const record = this.registry.get(sessionId)
    if (!record) {
      throw new Error(`session ${sessionId} does not exist`)
    }
    const restartCount = record.restartCount + 1
    this.killSession(sessionId)
    this.spawnSession(sessionId)
    const restarted = this.registry.get(sessionId)
    if (restarted) {
      restarted.restartCount = restartCount
    }
  }

  /** Kill every sidecar and clear the registry. */
  shutdown(): void {
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

    const socket = connect(record.socketPath)
    record.socket = socket

    socket.on('connect', () => {
      this.setStatus(record, 'ready')
    })

    socket.on('data', chunk => {
      const results = record.decoder.push(chunk)
      for (const result of results) {
        if (result.kind === 'error') {
          this.log(`[supervisor] frame decode error from ${record.sessionId}: ${result.reason}`)
          socket.destroy()
          return
        }
        this.emit({
          type: 'frame',
          sessionId: record.sessionId,
          frame: result.payload as ServerFrame,
        })
      }
    })

    socket.on('error', error => {
      this.log(`[supervisor] socket error for ${record.sessionId}: ${error.message}`)
    })

    socket.on('close', () => {
      if (record.socket !== socket) {
        return // a newer socket already replaced this one
      }
      record.socket = null
      // F13 — the socket closed. Do NOT keep reporting 'ready'. If the child is
      // gone the 'exit' handler will move to 'exited'; otherwise reflect the
      // disconnected state so send() fails fast and a UI/policy can react.
      if (record.status === 'ready' || record.status === 'connecting') {
        this.setStatus(record, 'disconnected')
      }
    })
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
