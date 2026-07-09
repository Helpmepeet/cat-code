/**
 * The desktop session registry (D1 — `decisions/REGISTRY.md`).
 *
 * An app-owned, durable INDEX over engine-owned transcripts. It remembers which
 * engine sessions the desktop had open, addressed how (the two-id model —
 * supervisor-minted `appSessionId` ↔ engine-minted `engineSessionId`), rooted
 * where (`cwd`). Session CONTENT stays engine-owned — this file NEVER stores
 * transcript bytes, message counts, secrets, or renderer layout (§3). Registry
 * loss is an inconvenience (the workspace forgets its tabs), not data loss: the
 * engine's transcript catalog is always the recovery path (§1, A2).
 *
 * This module is pure host-plane state (R1, §6 non-goals):
 *  - ZERO `electron` imports — Electron main is a *caller*, not the owner.
 *  - Does NOT talk to sockets and does NOT parse frames — it consumes supervisor
 *    events + the ready frame's `engineSessionId` relayed by the host layer.
 *  - Does NOT import the engine graph (`src/**`). The two pieces of engine
 *    behavior it needs — the config-home rules and the transcript path encoding
 *    — are RE-IMPLEMENTED here (matched against source, `envUtils.ts:15-21`,
 *    `sessionStoragePortable.ts:311-319,329-331`), never imported, so the host
 *    plane typechecks in isolation and never drags in the Bun engine runtime.
 *
 * Write discipline (§5 — the DR-2 lesson applied to our own new shared file):
 * every write goes through an advisory lockfile (proper-lockfile, the house
 * pattern) + an atomic temp-file + `rename` write. Writers retry briefly on a
 * held lock, then fail the WRITE (never the session) and log. The Electron
 * single-instance lock (P3-3) is a separate belt; this module must not depend on
 * a client's politeness.
 */

import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/* ------------------------------------------------------------------------- *
 * Schema (§3, registryVersion 1)
 * ------------------------------------------------------------------------- */

/** Current on-disk schema version. Unknown versions are moved aside (§4.1). */
export const REGISTRY_VERSION = 1 as const

/**
 * Beyond this many rows, oldest `shutdown != null` rows are reaped on write
 * (§3). Live rows (`shutdown == null`) are never reaped for the bound.
 */
export const MAX_REGISTRY_SESSIONS = 32

/** How a session ended, from the host's point of view (§3). */
export type ShutdownState = 'clean' | 'crashed' | null

/**
 * One persisted session row. Every field is either [D]urable (meaningful across
 * launches) or [A]dvisory (a runtime hint — rewritten every run, verified before
 * use, NEVER trusted).
 */
export type RegistrySession = {
  /** [D] the address — supervisor-minted UUID. */
  appSessionId: string
  /** [D] transcript key — engine-minted; null until the first ready frame. */
  engineSessionId: string | null
  /** [D] session root — spawn input, not an engine echo. */
  cwd: string
  /** [D] optional app-owned display name. */
  title?: string
  /** [D] */
  createdAt: number
  /** [D] recency for restore-ordering / reaping. */
  lastAttachedAt: number
  /** [D] "clean" | "crashed" | null (=currently live). */
  shutdown: ShutdownState
  /** [A] for the crash sweep only. */
  enginePid?: number
  /** [A] v2 re-attach seed; v1 cleanup + identity hint. */
  socketPath?: string
  /** [A] supervisor policy input. */
  restartCount?: number
}

/** The whole on-disk document. */
export type RegistryDocument = {
  registryVersion: typeof REGISTRY_VERSION
  /** [A] who last wrote; liveness-checked by readers. */
  hostPid: number
  /** [A] */
  updatedAt: number
  sessions: RegistrySession[]
}

/* ------------------------------------------------------------------------- *
 * Injected dependencies (tests stay hermetic)
 * ------------------------------------------------------------------------- */

export type RegistryOptions = {
  /**
   * Directory that holds `registry.json`. INJECTED at construction so tests
   * never touch the real config home. Canonical default (when omitted):
   * `<claude-config-home>/desktop` (see `defaultRegistryDir`).
   */
  storageDir?: string
  /** Structured logger. Defaults to stderr. */
  log?: (line: string) => void
  /**
   * Resolve the transcript file path for a session, given its `cwd` and
   * `engineSessionId`. INJECTED so tests can control transcript existence
   * without materializing the engine's project-dir layout. Default:
   * `defaultTranscriptPath` (re-implements the engine encoding host-side).
   */
  transcriptPathFor?: (cwd: string, engineSessionId: string) => string
  /**
   * Probe a pid's liveness. Default: signal-0 (`process.kill(pid, 0)`), the
   * `genericProcessUtils.ts:20` idiom re-implemented host-side.
   */
  isProcessAlive?: (pid: number) => boolean
  /**
   * Read a process's command line (for the §9-A3 identity check). Default:
   * `ps -o command= -p <pid>` on POSIX (`getProcessCommand` idiom). Returns
   * null when the process is gone or unreadable.
   */
  processCommand?: (pid: number) => string | null
  /**
   * A substring that MUST appear in an orphaned sidecar's command line before
   * the sweep will SIGTERM it (§9-A3: never kill on pid-match alone). INJECTED
   * so the host layer passes the real sidecar identity (the sidecar entry path
   * or packaged-binary name) and tests can pass a dummy marker. When omitted,
   * the identity check can only ever FAIL — i.e. the sweep degrades to
   * kill-nothing, the safe direction.
   */
  sidecarCommandMarker?: string
  /**
   * Send SIGTERM to an orphaned sidecar (§4.2, D6 §2). Default: `process.kill`.
   * Injected so tests can assert kill/spare decisions without racing a real
   * signal.
   */
  killProcess?: (pid: number) => void
  /**
   * Advisory-lock acquire. Returns a release function. Default: proper-lockfile
   * (lazy-required, the house pattern via `src/utils/lockfile.ts`). Injected so
   * tests can simulate a held lock deterministically.
   */
  acquireLock?: (file: string) => Promise<() => Promise<void>>
}

/* ------------------------------------------------------------------------- *
 * Config-home + transcript-path re-implementation (NOT imported from engine)
 * ------------------------------------------------------------------------- */

/**
 * `<claude-config-home>` — re-implements `envUtils.ts:15-21` host-side.
 * `CLAUDE_CONFIG_DIR` override, else `~/.cat-code`; NFC-normalized.
 */
export function claudeConfigHomeDir(): string {
  const fallback = join(homedir(), '.cat-code')
  return (process.env.CLAUDE_CONFIG_DIR ?? fallback).normalize('NFC')
}

/** Canonical default registry directory: `<config-home>/desktop`. */
export function defaultRegistryDir(): string {
  return join(claudeConfigHomeDir(), 'desktop')
}

const MAX_SANITIZED_LENGTH = 200

/**
 * djb2 — the `sessionStoragePortable.ts` `simpleHash` fallback, re-implemented
 * host-side (the engine prefers `Bun.hash`, but the host plane runs under Node
 * and must not depend on Bun; djb2 is the portable branch the engine itself
 * uses off-Bun, so a Node-written project dir matches an SDK-under-Node one).
 */
function djb2Hash(str: string): number {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i)
  }
  return hash >>> 0
}

/**
 * Re-implements `sanitizePath` (`sessionStoragePortable.ts:311-319`): non-alnum
 * → `-`; paths over the length bound get a hash suffix.
 */
function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized
  const hash = Math.abs(djb2Hash(name)).toString(36)
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${hash}`
}

/**
 * The engine's transcript path for a session, re-derived host-side:
 * `<config-home>/projects/<sanitizePath(cwd)>/<engineSessionId>.jsonl`
 * (`sessionStoragePortable.ts:325-331` + `sessionStorage.ts:255`).
 *
 * For the common case (`cwd` under the length bound), the encoding is a pure
 * regex and matches the engine exactly. For long paths where the engine may
 * have used `Bun.hash`, our djb2 suffix can differ — so we fall back to a
 * prefix scan of the projects dir (mirrors `findProjectDir`
 * `sessionStoragePortable.ts:354-372`) before declaring the transcript gone.
 */
export function defaultTranscriptPath(cwd: string, engineSessionId: string): string {
  // F6 (host-plane review 2026-07-05): the engine canonicalizes with realpath +
  // NFC (`canonicalizePath`, sessionStoragePortable.ts:339-345) before
  // sanitizing, so a decomposed-Unicode (NFD, macOS-typical) cwd must be
  // NFC-normalized here too or the sanitized project dir diverges and a
  // restorable session is wrongly refused.
  const canonicalCwd = cwd.normalize('NFC')
  const projectsDir = join(claudeConfigHomeDir(), 'projects')
  const exact = join(projectsDir, sanitizePath(canonicalCwd), `${engineSessionId}.jsonl`)
  if (existsSync(exact)) return exact

  // Long-path fallback: the exact dir may carry a different hash suffix than
  // the engine wrote. Scan for a project dir sharing the sanitized prefix that
  // actually contains this transcript, mirroring findProjectDir's tolerance.
  const sanitized = canonicalCwd.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length > MAX_SANITIZED_LENGTH) {
    const prefix = sanitized.slice(0, MAX_SANITIZED_LENGTH)
    try {
      for (const dir of readdirSync(projectsDir)) {
        if (!dir.startsWith(prefix)) continue
        const candidate = join(projectsDir, dir, `${engineSessionId}.jsonl`)
        if (existsSync(candidate)) return candidate
      }
    } catch {
      // projects dir missing / unreadable — fall through to the exact path
    }
  }
  return exact
}

/* ------------------------------------------------------------------------- *
 * Default liveness / identity probes (host-side, POSIX-first like the engine)
 * ------------------------------------------------------------------------- */

/** signal-0 liveness probe (`genericProcessUtils.ts:20`). */
function defaultIsProcessAlive(pid: number): boolean {
  if (pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // EPERM (alive but owned by another user) reports NOT running — conservative
    // for a kill decision: we never SIGTERM a process we couldn't even probe.
    return false
  }
}

/** `ps -o command= -p <pid>` (`getProcessCommand` idiom, no shell). */
function defaultProcessCommand(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ],
        { timeout: 2000, encoding: 'utf8' },
      )
      return out.trim() || null
    }
    const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      timeout: 2000,
      encoding: 'utf8',
    })
    return out.trim() || null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------------- *
 * SessionRegistry
 * ------------------------------------------------------------------------- */

/** File name in a corrupt-move-aside: `registry.json.corrupt-<ts>`. */
function corruptName(ts: number): string {
  return `registry.json.corrupt-${ts}`
}

export class SessionRegistry {
  private readonly dir: string
  private readonly path: string
  private readonly log: (line: string) => void
  private readonly transcriptPathFor: (cwd: string, engineSessionId: string) => string
  private readonly isProcessAlive: (pid: number) => boolean
  private readonly processCommand: (pid: number) => string | null
  private readonly sidecarCommandMarker: string | undefined
  private readonly killProcess: (pid: number) => void
  private readonly acquireLock: (file: string) => Promise<() => Promise<void>>

  /** In-memory mirror of the on-disk document; the write points mutate it. */
  private doc: RegistryDocument

  /**
   * Whether the LAST `persist()` failed to write (held lock or IO error). The
   * write is swallowed (never throws — §5, a session must outlive a persistence
   * failure), but the host layer reads this to surface `registry_unavailable`
   * (HostErrorCode) as a NON-fatal degraded-persistence signal.
   */
  private writeFailed = false

  constructor(options: RegistryOptions = {}) {
    this.dir = options.storageDir ?? defaultRegistryDir()
    this.path = join(this.dir, 'registry.json')
    this.log = options.log ?? (line => process.stderr.write(`${line}\n`))
    this.transcriptPathFor = options.transcriptPathFor ?? defaultTranscriptPath
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive
    this.processCommand = options.processCommand ?? defaultProcessCommand
    this.sidecarCommandMarker = options.sidecarCommandMarker
    this.killProcess = options.killProcess ?? ((pid: number) => process.kill(pid, 'SIGTERM'))
    this.acquireLock = options.acquireLock ?? defaultAcquireLock
    this.doc = emptyDoc()
  }

  /** Where the registry file lives (advisory; for logs/tests). */
  get filePath(): string {
    return this.path
  }

  /** A defensive copy of the current in-memory rows. */
  get sessions(): RegistrySession[] {
    return this.doc.sessions.map(row => ({ ...row }))
  }

  /**
   * True when the most recent write could not be persisted (§5). The in-memory
   * doc is still authoritative for this run; the host surfaces this as a
   * non-fatal `registry_unavailable` and keeps the session alive.
   */
  get lastWriteFailed(): boolean {
    return this.writeFailed
  }

  /** Look up one row by appSessionId (defensive copy), or undefined. */
  findSession(appSessionId: string): RegistrySession | undefined {
    const row = this.find(appSessionId)
    return row ? { ...row } : undefined
  }

  /**
   * Whether the row's engine transcript still exists on disk RIGHT NOW. The
   * launch reap (§4.3) drops rows whose transcript is gone, but a transcript can
   * be pruned between launch and a restore click — so restore must re-check
   * (§9-A4: never offer a restore it cannot perform). False when the row is
   * unknown or has no `engineSessionId` yet (nothing to resume).
   */
  hasTranscript(appSessionId: string): boolean {
    const row = this.find(appSessionId)
    if (!row || row.engineSessionId === null) return false
    return existsSync(this.transcriptPathFor(row.cwd, row.engineSessionId))
  }

  /**
   * True when the row's advisory pid/socket still identify a live sidecar. Used
   * before restore so a fresh sidecar never resumes the same transcript while an
   * old writer is still plausibly alive.
   */
  hasLiveAdvisorySidecar(appSessionId: string): boolean {
    const row = this.find(appSessionId)
    return row ? this.matchesSidecarIdentity(row) : false
  }

  /* --------------------------------------------------------------------- *
   * §4 — launch sequence (read+validate → sweep → reap → restore data)
   * --------------------------------------------------------------------- */

  /**
   * Run the full launch sequence and return the restore-offer rows (§4.4:
   * ordered by `lastAttachedAt` desc, `crashed` flagged). Persists the swept +
   * reaped document once at the end. Call exactly once, before any spawn.
   */
  async launch(): Promise<RegistrySession[]> {
    // (1) read + validate — corrupt/unknown-version → move aside, start empty.
    this.doc = this.readOrRecover()
    // (2) liveness sweep for rows with shutdown == null.
    this.sweepOrphans()
    // (3) reap over-bound + missing-transcript + null-engineSessionId-clean rows.
    this.reap()
    // Persist the post-launch state (best-effort — a failed write never fails
    // the launch; the in-memory doc is authoritative for this run).
    await this.persist()
    // (4) restore-offer data.
    return this.restorable()
  }

  /**
   * (1) Read + validate. Unparseable JSON or an unknown `registryVersion` moves
   * the file aside (`registry.json.corrupt-<ts>`) and starts empty, logging
   * loudly (§4.1). Safe because the registry is an index, not a backup (A2).
   */
  private readOrRecover(): RegistryDocument {
    if (!existsSync(this.path)) return emptyDoc()

    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch (error) {
      this.log(`[registry] could not read ${this.path}: ${errText(error)}; starting empty`)
      return emptyDoc()
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      this.moveAside(`unparseable JSON: ${errText(error)}`)
      return emptyDoc()
    }

    const validated = validateDocument(parsed)
    if (!validated) {
      this.moveAside('unknown registryVersion or malformed document')
      return emptyDoc()
    }
    return validated
  }

  private moveAside(reason: string): void {
    const target = join(this.dir, corruptName(Date.now()))
    try {
      renameSync(this.path, target)
      this.log(
        `[registry] CORRUPT registry (${reason}) — moved aside to ${target}; starting empty. ` +
          'The engine transcript catalog remains the recovery path.',
      )
    } catch (error) {
      this.log(
        `[registry] CORRUPT registry (${reason}) and could not move it aside ` +
          `(${errText(error)}); starting empty and will overwrite on next write.`,
      )
    }
  }

  /**
   * (2) Liveness sweep. For each row with `shutdown == null` (the host died
   * without marking it), probe `enginePid`:
   *  - alive AND identity matches (§9-A3) → orphaned sidecar → v1 policy KILL
   *    (SIGTERM, D6 §2).
   *  - dead, recycled pid, or identity mismatch → nothing to kill.
   * Either way the row becomes `crashed`. Advisory pid/socket hints are retained
   * so `restoreSession` can refuse while a prior writer still matches identity.
   */
  private sweepOrphans(): void {
    for (const row of this.doc.sessions) {
      if (row.shutdown !== null) continue

      const pid = row.enginePid
      if (typeof pid === 'number' && this.matchesSidecarIdentity(row)) {
        try {
          this.killProcess(pid)
          this.log(`[registry] swept orphaned sidecar pid=${pid} (session ${row.appSessionId})`)
        } catch (error) {
          this.log(`[registry] failed to SIGTERM orphan pid=${pid}: ${errText(error)}`)
        }
      }

      row.shutdown = 'crashed'
    }
  }

  /**
   * §9-A3 — kill ONLY when pid liveness AND identity both hold. Identity =
   * the row's `socketPath` still exists on disk AND the process's command line
   * contains the injected sidecar marker. If either identity signal is missing,
   * treat the process as not-ours and never kill (stricter than
   * `concurrentSessions.ts:192`, which only probes liveness because it never
   * kills).
   */
  private matchesSidecarIdentity(row: RegistrySession): boolean {
    const pid = row.enginePid
    if (typeof pid !== 'number') return false
    if (!this.isProcessAlive(pid)) return false
    // Identity signal 1: the row's socket file still exists.
    if (!row.socketPath || !existsSync(row.socketPath)) return false
    // Identity signal 2: the process cmdline is the sidecar binary. Without an
    // injected marker we CANNOT assert this — so we refuse to kill (safe).
    if (!this.sidecarCommandMarker) return false
    const cmd = this.processCommand(pid)
    if (!cmd || !cmd.includes(this.sidecarCommandMarker)) return false
    return true
  }

  /**
   * (3) Reap: drop rows whose transcript is gone, `shutdown:"clean"` rows that
   * never acquired an `engineSessionId` (§9-A5 — an address that never got
   * content is not restorable), and — for the bound — the oldest terminal
   * (`shutdown != null`) rows over `MAX_REGISTRY_SESSIONS`.
   */
  private reap(): void {
    // Drop missing-transcript rows and null-engineSessionId clean rows.
    this.doc.sessions = this.doc.sessions.filter(row => {
      if (row.shutdown === 'clean' && row.engineSessionId === null) {
        this.log(
          `[registry] reaped clean row with no engineSessionId (${row.appSessionId}) — ` +
            'never acquired content, not restorable',
        )
        return false
      }
      if (row.engineSessionId !== null && this.transcriptMissing(row)) {
        this.log(
          `[registry] reaped row whose transcript is gone (${row.appSessionId} / ` +
            `${row.engineSessionId})`,
        )
        return false
      }
      return true
    })

    this.enforceBound()
  }

  private transcriptMissing(row: RegistrySession): boolean {
    if (row.engineSessionId === null) return false
    const path = this.transcriptPathFor(row.cwd, row.engineSessionId)
    return !existsSync(path)
  }

  /**
   * Reap oldest terminal rows over the bound. Live rows (`shutdown == null`)
   * are never reaped; only `shutdown != null` rows are eligible, oldest
   * (`lastAttachedAt`) first — matches §3. Returns the reaped ids so a
   * runtime caller can emit `session-removed` for them (F5).
   */
  private enforceBound(): string[] {
    if (this.doc.sessions.length <= MAX_REGISTRY_SESSIONS) return []

    const terminal = this.doc.sessions
      .filter(r => r.shutdown !== null)
      .sort((a, b) => a.lastAttachedAt - b.lastAttachedAt)
    const removeCount = this.doc.sessions.length - MAX_REGISTRY_SESSIONS
    const doomedRows = terminal.slice(0, removeCount)
    const doomed = new Set(doomedRows.map(r => r.appSessionId))
    if (doomed.size > 0) {
      // CC-3 (docs O1) — evict-reap. Dropping a terminal row makes its orphan
      // permanently unreachable: no future launch sweep can see a pid whose row
      // no longer exists. So, before the row disappears, SIGTERM its sidecar iff
      // pid liveness AND identity both hold — the SAME §9-A3 check the orphan
      // sweep uses (never kill on pid-match alone; a recycled pid or a cleanly
      // shut-down session's dead pid is spared). A clean row's sidecar was already
      // killed at close, so its pid fails the liveness check and nothing happens.
      for (const row of doomedRows) {
        const pid = row.enginePid
        if (typeof pid === 'number' && this.matchesSidecarIdentity(row)) {
          try {
            this.killProcess(pid)
            this.log(
              `[registry] evict-reaped orphaned sidecar pid=${pid} for over-bound row ${row.appSessionId}`,
            )
          } catch (error) {
            this.log(
              `[registry] failed to SIGTERM evicted orphan pid=${pid}: ${errText(error)}`,
            )
          }
        }
      }
      this.doc.sessions = this.doc.sessions.filter(r => !doomed.has(r.appSessionId))
      this.log(`[registry] reaped ${doomed.size} over-bound terminal row(s)`)
    }
    return [...doomed]
  }

  /** (4) Restore-offer rows: by `lastAttachedAt` desc; `crashed` already flagged. */
  restorable(): RegistrySession[] {
    return [...this.doc.sessions]
      .sort((a, b) => b.lastAttachedAt - a.lastAttachedAt)
      .map(row => ({ ...row }))
  }

  /* --------------------------------------------------------------------- *
   * §4.5 — write points (each mutates the in-memory doc, then persists atomically)
   * --------------------------------------------------------------------- */

  /**
   * Upsert on spawn. Creates a live row (`shutdown: null`) or, if the row
   * already exists (restart / restore of a known appSessionId), refreshes its
   * advisory fields, marks it live again, and bumps `restartCount` (one bump
   * per actual re-spawn — F4: advisory-field refreshes go through
   * `setAdvisoryRuntime`, which never touches the counter). `engineSessionId`
   * stays null until the ready frame fills it (§4.5).
   *
   * Returns the appSessionIds of any terminal rows reaped to make room (F5):
   * the host emits `session-removed` for them so a live subscriber's list
   * projection never keeps ghosts.
   */
  async upsertOnSpawn(input: {
    appSessionId: string
    cwd: string
    title?: string
    enginePid?: number
    socketPath?: string
  }): Promise<string[]> {
    const now = Date.now()
    let reaped: string[] = []
    const existing = this.find(input.appSessionId)
    if (existing) {
      existing.cwd = input.cwd
      if (input.title !== undefined) existing.title = input.title
      existing.enginePid = input.enginePid
      existing.socketPath = input.socketPath
      existing.lastAttachedAt = now
      existing.shutdown = null
      existing.restartCount = (existing.restartCount ?? 0) + 1
    } else {
      this.doc.sessions.push({
        appSessionId: input.appSessionId,
        engineSessionId: null,
        cwd: input.cwd,
        ...(input.title !== undefined ? { title: input.title } : {}),
        createdAt: now,
        lastAttachedAt: now,
        shutdown: null,
        enginePid: input.enginePid,
        socketPath: input.socketPath,
        restartCount: 0,
      })
      // A fresh spawn may push us over the bound; reap terminal rows to make room.
      reaped = this.enforceBound()
    }
    await this.persist()
    return reaped
  }

  /**
   * Refresh only the advisory runtime hints for a live row (F4): the child's
   * pid + socketPath once the spawn returned. Never touches `restartCount`,
   * `lastAttachedAt`, or shutdown state — those belong to the §4.5 write
   * points, not to this hint refresh.
   */
  async setAdvisoryRuntime(
    appSessionId: string,
    input: { enginePid?: number; socketPath?: string },
  ): Promise<void> {
    const row = this.find(appSessionId)
    if (!row) {
      this.log(`[registry] setAdvisoryRuntime: no row for ${appSessionId}`)
      return
    }
    row.enginePid = input.enginePid
    row.socketPath = input.socketPath
    await this.persist()
  }

  /** Fill `engineSessionId` on the ready frame (the two-id bridge, §2/§4.5). */
  async fillEngineSessionId(appSessionId: string, engineSessionId: string): Promise<void> {
    const row = this.find(appSessionId)
    if (!row) {
      this.log(`[registry] fillEngineSessionId: no row for ${appSessionId}`)
      return
    }
    row.engineSessionId = engineSessionId
    row.lastAttachedAt = Date.now()
    await this.persist()
  }

  /** Update the app-owned title on rename (§4.5). */
  async setTitle(appSessionId: string, title: string): Promise<void> {
    const row = this.find(appSessionId)
    if (!row) {
      this.log(`[registry] setTitle: no row for ${appSessionId}`)
      return
    }
    row.title = title
    await this.persist()
  }

  /** Heartbeat `lastAttachedAt` on attach (§4.5). */
  async touchAttached(appSessionId: string): Promise<void> {
    const row = this.find(appSessionId)
    if (!row) {
      this.log(`[registry] touchAttached: no row for ${appSessionId}`)
      return
    }
    row.lastAttachedAt = Date.now()
    await this.persist()
  }

  /**
   * Mark a LIVE row `crashed` when its sidecar died without a graceful close
   * (F3): the exit/failed supervisor event, not the quit path, is what makes a
   * crash a crash. Only transitions rows with `shutdown === null` — a row that
   * is already terminal (clean close, quit-time `markLiveCleanSync`) keeps its
   * state, so the shutdownAll ordering (mark clean, THEN kill) stays correct.
   * Advisory runtime fields are retained for restore-time prior-writer checks.
   */
  async markCrashed(appSessionId: string): Promise<void> {
    const row = this.find(appSessionId)
    if (!row) {
      this.log(`[registry] markCrashed: no row for ${appSessionId}`)
      return
    }
    if (row.shutdown !== null) return
    row.shutdown = 'crashed'
    await this.persist()
  }

  /**
   * Mark `shutdown: "clean"` on graceful close (§4.5, inside killSession/
   * shutdown). The row is KEPT (restorable); advisory runtime fields are retained
   * so restore can refuse if the old writer did not actually die.
   */
  async markClean(appSessionId: string): Promise<void> {
    const row = this.find(appSessionId)
    if (!row) {
      this.log(`[registry] markClean: no row for ${appSessionId}`)
      return
    }
    row.shutdown = 'clean'
    await this.persist()
  }

  private find(appSessionId: string): RegistrySession | undefined {
    return this.doc.sessions.find(r => r.appSessionId === appSessionId)
  }

  /**
   * SYNCHRONOUS clean-marking for the exit path (B3 / die-with-window). Marks
   * every currently-live row (`shutdown == null`) clean, retaining advisory fields
   * for restore-time prior-writer checks, and writes ONCE atomically — bypassing
   * the async advisory lock because this
   * runs on `window-all-closed`/`before-quit`, where (a) we hold the OS
   * single-instance lock so we are the only writer, and (b) the process may exit
   * before an async persist could settle. A write failure is swallowed (the row
   * state is re-derivable; a launch sweep would just mark them crashed instead).
   * Returns the ids it marked.
   */
  markLiveCleanSync(): string[] {
    const marked: string[] = []
    for (const row of this.doc.sessions) {
      if (row.shutdown !== null) continue
      row.shutdown = 'clean'
      marked.push(row.appSessionId)
    }
    if (marked.length === 0) return marked
    this.doc.hostPid = process.pid
    this.doc.updatedAt = Date.now()
    try {
      ensureDir(this.dir)
      atomicWriteJson(this.path, this.doc)
      this.writeFailed = false
    } catch (error) {
      this.writeFailed = true
      this.log(`[registry] markLiveCleanSync write failed (${errText(error)})`)
    }
    return marked
  }

  /* --------------------------------------------------------------------- *
   * §5 — write discipline (lockfile + atomic temp-rename; fail the write, not
   * the session)
   * --------------------------------------------------------------------- */

  /**
   * Persist the in-memory doc atomically under an advisory lock. On a held
   * lock (retries exhausted) or any write failure, log and return WITHOUT
   * throwing — a persistence failure must never take down a live session
   * (§5, HostErrorCode `registry_unavailable`). The in-memory doc stays the
   * source of truth for this run.
   */
  private async persist(): Promise<void> {
    this.doc.hostPid = process.pid
    this.doc.updatedAt = Date.now()

    try {
      ensureDir(this.dir)
    } catch (error) {
      this.writeFailed = true
      this.log(
        `[registry] could not ensure ${this.dir} (${errText(error)}); ` +
          'skipping this write — session unaffected',
      )
      return
    }

    let release: (() => Promise<void>) | undefined
    try {
      release = await this.acquireLock(this.path)
    } catch (error) {
      this.writeFailed = true
      this.log(
        `[registry] could not acquire lock for ${this.path} (${errText(error)}); ` +
          'skipping this write — session unaffected',
      )
      return
    }

    try {
      atomicWriteJson(this.path, this.doc)
      this.writeFailed = false
    } catch (error) {
      this.writeFailed = true
      this.log(`[registry] atomic write failed (${errText(error)}); session unaffected`)
    } finally {
      try {
        await release()
      } catch {
        // best-effort unlock
      }
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Module-private helpers
 * ------------------------------------------------------------------------- */

function emptyDoc(): RegistryDocument {
  return {
    registryVersion: REGISTRY_VERSION,
    hostPid: process.pid,
    updatedAt: Date.now(),
    sessions: [],
  }
}

/**
 * Validate a parsed object into a `RegistryDocument`, or return null (→ move
 * aside). Rejects unknown versions and rebuilds the sessions array defensively:
 * a malformed row is dropped, not trusted (the registry is re-derivable).
 */
function validateDocument(parsed: unknown): RegistryDocument | null {
  if (!isRecord(parsed)) return null
  if (parsed.registryVersion !== REGISTRY_VERSION) return null
  if (!Array.isArray(parsed.sessions)) return null

  const sessions: RegistrySession[] = []
  for (const candidate of parsed.sessions) {
    const row = validateRow(candidate)
    if (row) sessions.push(row)
  }

  return {
    registryVersion: REGISTRY_VERSION,
    hostPid: typeof parsed.hostPid === 'number' ? parsed.hostPid : process.pid,
    updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    sessions,
  }
}

function validateRow(candidate: unknown): RegistrySession | null {
  if (!isRecord(candidate)) return null
  if (typeof candidate.appSessionId !== 'string' || candidate.appSessionId.length === 0) {
    return null
  }
  if (typeof candidate.cwd !== 'string' || candidate.cwd.length === 0) return null

  const engineSessionId =
    typeof candidate.engineSessionId === 'string' ? candidate.engineSessionId : null
  const shutdown = normalizeShutdown(candidate.shutdown)

  const row: RegistrySession = {
    appSessionId: candidate.appSessionId,
    engineSessionId,
    cwd: candidate.cwd,
    createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now(),
    lastAttachedAt:
      typeof candidate.lastAttachedAt === 'number' ? candidate.lastAttachedAt : Date.now(),
    shutdown,
  }
  if (typeof candidate.title === 'string') row.title = candidate.title
  if (typeof candidate.enginePid === 'number') row.enginePid = candidate.enginePid
  if (typeof candidate.socketPath === 'string') row.socketPath = candidate.socketPath
  if (typeof candidate.restartCount === 'number') row.restartCount = candidate.restartCount
  return row
}

function normalizeShutdown(value: unknown): ShutdownState {
  if (value === 'clean' || value === 'crashed') return value
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
}

/**
 * Atomic temp-file + fsync + rename write (the `atomicWriteJson` idiom,
 * `codexTokenRefresh.ts:913-952`). A reader that crashes mid-write sees either
 * the old file or the new one — never a torn document (rename is atomic).
 */
function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = dirname(filePath)
  const tmpPath = join(dir, `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`)
  const json = `${JSON.stringify(data, null, 2)}\n`

  let fd: number | undefined
  try {
    fd = openSync(tmpPath, 'w', 0o600)
    writeFileSync(fd, json, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
      fd = undefined
    }
    try {
      unlinkSync(tmpPath)
    } catch {
      // ignore
    }
    throw err
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    }
  }

  renameSync(tmpPath, filePath)

  // fsync the directory so the rename is durable (crash-safety parity with the
  // engine idiom); tolerate platforms that disallow opening a dir for read.
  let dirFd: number | undefined
  try {
    dirFd = openSync(dir, 'r')
    fsyncSync(dirFd)
  } catch {
    // ignore
  } finally {
    if (dirFd !== undefined) closeSync(dirFd)
  }
}

/**
 * The slice of proper-lockfile this module uses. Declared locally (there is no
 * `@types/proper-lockfile` in the tree, and the host plane must not depend on
 * the engine's looser typecheck) so the isolated app tsconfig stays clean
 * without adding a dependency.
 */
type ProperLockfile = {
  lock: (
    file: string,
    options?: {
      realpath?: boolean
      stale?: number
      retries?: {
        retries: number
        factor: number
        minTimeout: number
        maxTimeout: number
        randomize: boolean
      }
    },
  ) => Promise<() => Promise<void>>
}

/**
 * Default advisory-lock acquire via proper-lockfile — lazy-required so the
 * graceful-fs monkey-patch cost is paid only when a write actually happens
 * (the `src/utils/lockfile.ts` rationale, re-homed in the host plane so this
 * module imports nothing from `src/**`).
 *
 * proper-lockfile locks `<file>.lock`; it does NOT require `<file>` to exist,
 * but its default `realpath: true` does — so we disable realpath and let it
 * lock the path directly (the registry file may not exist on the very first
 * write). Retries are bounded, then the caller fails the WRITE, not the session.
 */
async function defaultAcquireLock(file: string): Promise<() => Promise<void>> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const lockfile = require('proper-lockfile') as ProperLockfile
  return lockfile.lock(file, {
    realpath: false,
    retries: {
      retries: 10,
      factor: 1.5,
      minTimeout: 50,
      maxTimeout: 500,
      randomize: true,
    },
    stale: 20_000,
  })
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A convenience UUID minter for callers that need an appSessionId. */
export function mintAppSessionId(): string {
  return randomUUID()
}
