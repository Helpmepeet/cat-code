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
 *
 * This is a FILE-GROWTH backstop only — NOT a spawn limit. The HC4 bound on how
 * many engine processes may be live at once is `MAX_LIVE_SESSIONS`
 * (`../shared/hostApi.ts`); the two were one constant until 2026-07-26, so
 * raising this one silently raised the fork-bomb cap. Keep them separate.
 *
 * Sized at 256 (was 32) per the 2026-07-26 ruling in `decisions/REGISTRY.md` §3.
 * The old value was justified by A5 accretion hygiene, which the immediate reap
 * of never-ran-a-turn rows already handles independently, and it was chosen when
 * the registry was the ONLY session list — post-SESSIONS-UNIFICATION history is
 * unlimited and this file is just the open+restorable layer. At 32 the operator's
 * real registry sat permanently at 32/32, so every open-from-history evicted a
 * genuinely-restorable session: a READ action destroyed state, unsignalled.
 * Measured cost at 256 rows (real-shaped rows, ~300 B/row): 98 KB file,
 * `launch()` 1.20 ms vs 0.53 ms at 32, per-write persist 0.50 ms vs 0.39 ms.
 */
export const MAX_REGISTRY_SESSIONS = 256

/**
 * How far back `fillMissingNames` reaches when it repairs rows that lost their
 * `name` (PEER-SESSIONS §2). Measured by `lastAttachedAt` — the same field
 * `enforceBound` reaps on, so "recent" means one thing in this file.
 *
 * This bounds a REPAIR, not the naming rule. Rows written from here on are named
 * at spawn by `upsertOnSpawn`, and names are write-once, so the named set only
 * grows; the window exists solely because one launch of a build predating the
 * field can strip a whole registry at once, and the repair that follows should
 * not hand a model back the entire archive.
 *
 * Sized at 7 days off the operator's real registry (2026-09-04, 224 rows, 223 of
 * them stripped): 1 day covers 15 rows, 3 days 35, 7 days 56, 14 days 118, 30
 * days 199. Seven days is the last step where the addressable roster stays
 * something a model can read in a `ListPeers` result rather than a wall of
 * history.
 *
 * The cost is accepted, not overlooked: a stripped row OLDER than this stays
 * nameless forever. `peersOf` (`app/main/peerRequestPlane.ts:521`) drops rows
 * without a name, so such a row can never be listed, therefore never woken,
 * therefore never spawned, therefore never named on the spawn path. That is the
 * intended trade — those rows remain openable from history by hand, they are
 * simply not peers.
 */
export const NAME_REPAIR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * How a session ended, from the host's point of view (§3).
 *
 * `'parked'` is the IDLE-PARK (decisions/IDLE-PARK.md §2/§8) in-memory-only
 * state: a session whose engine process was reclaimed while its tab stays open.
 * It projects like `'crashed'` to the descriptor (`disconnected` + `restorable`,
 * so the tab is kept and unpark = the existing restore-on-click), but it is
 * EXCLUDED from the `enforceBound` reap (a parked row is an open tab, not a
 * terminal row) and normalises to `'crashed'` on disk read — so it never
 * survives a relaunch as a distinct state. That read-time rule is for the
 * app-crashed-while-parked case only: an ordinary quit marks parked rows
 * `'clean'` first (`markLiveCleanSync`), so a normal relaunch never sees one.
 */
export type ShutdownState = 'clean' | 'crashed' | 'parked' | null

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
  /** [D] trusted desktop branch provenance. */
  forked: boolean
  /**
   * [D] Wall-clock at which `title` last CHANGED, or absent when it never has
   * (including rows written before this field existed). The recency half of the
   * title-precedence rule the renderer applies (`app/renderer/src/sessionsCatalogState.ts`
   * `pickTitle`): a title recorded in the engine transcript outranks this row's
   * title only when the sessions-catalog snapshot carrying it was captured LATER,
   * so a terminal `/rename` (transcript-only — `src/commands/rename/rename.ts:57`)
   * reaches the desktop while a desktop rename, which writes both sides, is never
   * reverted by an older snapshot.
   *
   * Only a real change of intent stamps it. A restore replays the row's OWN title
   * back through `upsertOnSpawn` (`app/host/host.ts:332`); re-stamping there would
   * let an untouched title float ahead of a genuinely newer transcript title on
   * every reopen.
   */
  titleUpdatedAt?: number
  /**
   * [D] The session's peer NAME (PEER-SESSIONS §2) — short, pool-allocated, and
   * unique across the registry, so a model can address "Bear" instead of a UUID.
   * Every LIVE row has one: the spawn path allocates when it is missing.
   *
   * Absent on a row that lost the field to a build predating it (`validateRow`
   * is a closed whitelist) and was last attached longer ago than
   * `NAME_REPAIR_WINDOW_MS`, which is where the launch repair stops. Such a row
   * keeps no name for the rest of its life — deliberately: see the constant.
   *
   * NOT the title: `title` is display text the user or the engine may rewrite at
   * any time (`titleUpdatedAt` above), while the name is minted once and only
   * released when the row is reaped, after which the pool may hand it out again.
   */
  name?: string
  /**
   * [D] The `appSessionId` of the session that created this one, when an agent
   * did (PEER-SESSIONS §2). An ID, deliberately NEVER a name: names are reused
   * after a reap and ids are not, so a stored name could silently come to mean a
   * different session. Readers resolve it to a name at read time and say the
   * creator is gone when no row carries the id any more.
   */
  createdBy?: string
  /**
   * [D] The NAME the creator carried when this row was made, stored beside the
   * id rather than instead of it (F17, ruling 11 of 2026-09-06). The id above is
   * what identity is decided by; this is the label the created session was told,
   * and it has to outlive the creator because that is exactly when it is needed.
   * Resolving it live instead returns nothing once the creator's row is reaped,
   * which is the one moment a reissued name can point somewhere new, so a peer
   * booted after that reap would send with no expectation to check and the
   * message would reach whoever now holds the name. WRITE-ONCE with `createdBy`.
   */
  createdByName?: string
  /**
   * [D] The user's standing "do not let peers reopen this" answer (PEER-SESSIONS
   * §6, HOST-REQUEST-PLANE §5). Absent means false. Durable on purpose: it
   * survives close, park, restore and relaunch, and disappears only with the row
   * on reap. Only the user ever clears it — reopening the session by hand does
   * NOT, because the flag is about who may WAKE the session, not about whether it
   * is currently open. A live row ignores it: peer messages still arrive, since
   * there is nothing to reopen.
   */
  peerWakeBlocked?: boolean
  /** [D] */
  createdAt: number
  /** [D] recency for restore-ordering / reaping. */
  lastAttachedAt: number
  /**
   * [D] Wall-clock of the last MESSAGE SENT this session (i.e. a turn actually
   * ran), or null if none since the row was created. The CC-2 sidebar-recency
   * signal (`app/renderer/src/sidebarState.ts` deferred spec): unlike
   * `lastAttachedAt`, attach/restore/spawn must NEVER bump it — only
   * `markMessageSent` does, driven off a live (non-replay) turn-end frame in
   * `host.ts`. Persisted so it survives restart; parsed with a null default for
   * pre-existing rows.
   */
  lastMessageSentAt: number | null
  /** [D] "clean" | "crashed" | "parked" (IDLE-PARK, in-memory only) | null (=live). */
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
   * Read the registry document. Injected so read-failure behavior is testable;
   * a failed read must preserve the existing file rather than overwrite it with
   * an empty document on this run.
   */
  readRegistryFile?: (path: string) => string
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
  /** Synchronous counterpart for the quit path, which cannot await a lock. */
  acquireLockSync?: (file: string) => () => void
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
  private readonly acquireLockSync: (file: string) => () => void
  private readonly readRegistryFile: (path: string) => string

  /** In-memory mirror of the on-disk document; the write points mutate it. */
  private doc: RegistryDocument

  /** Last document known to have reached disk; used to derive a local delta. */
  private persistedDoc: RegistryDocument

  /** A failed startup read makes all writes fail closed for the current run. */
  private readFailed = false

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
    this.acquireLockSync = options.acquireLockSync ?? defaultAcquireLockSync
    this.readRegistryFile = options.readRegistryFile ?? (path => readFileSync(path, 'utf8'))
    this.doc = emptyDoc()
    this.persistedDoc = cloneDocument(this.doc)
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
    this.persistedDoc = cloneDocument(this.doc)
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
      raw = this.readRegistryFile(this.path)
    } catch (error) {
      this.readFailed = true
      this.writeFailed = true
      this.log(
        `[registry] could not read ${this.path}: ${errText(error)}; ` +
          'preserving the existing file and disabling registry writes for this run',
      )
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
        `[registry] CORRUPT registry (${reason}): moved aside to ${target}; starting empty. ` +
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
   * (3) Reap: drop rows whose transcript is gone, TERMINAL rows that never
   * acquired an `engineSessionId` (an address that never got content is not
   * restorable), and — for the bound — the oldest terminal (`shutdown != null`)
   * rows over `MAX_REGISTRY_SESSIONS`.
   *
   * The null-`engineSessionId` rule used to read `shutdown === 'clean'`, so a
   * row whose process died before its first ready frame was kept forever: it
   * has no transcript, so `hasTranscript` is false, so `canResume` is false, so
   * the host's `isRestorable` refuses it and it never reaches `listSessions` —
   * invisible in the sidebar, in the palette, in the peer roster, and refused by
   * every open path there is. The operator's file held 13 of them. What produces
   * them is ordinary: a `src/**` or `app/sidecar/**` edit kills every new
   * session an open dev app starts (CLAUDE.md §3), and each one leaves a row.
   *
   * This does not reverse HOST-REQUEST-PLANE §2's ruling that a peer create
   * whose ready or prompt step failed KEEPS its row. That ruling turns on the
   * row being "a real session the operator can see", and it holds for the whole
   * run in which the failure happened, because this pass runs only from
   * `launch()`. By the next launch there is no tab to dangle and nothing left
   * to see: what remains is an address for content that was never written.
   * `'parked'` is included for the same reason it is exempt from the BOUND reap
   * and not from this one: the exemption exists because a parked row is an open
   * tab, and at launch there are no tabs. (A parked row read at launch has
   * already been normalized to `'crashed'` — §8 — so this is about intent, not
   * an extra case.) The `shutdown !== null` guard is a safety net rather than a
   * live branch: `sweepOrphans` runs first and settles every row.
   */
  private reap(): void {
    // Drop missing-transcript rows and null-engineSessionId terminal rows.
    this.doc.sessions = this.doc.sessions.filter(row => {
      if (row.shutdown !== null && row.engineSessionId === null) {
        this.log(
          `[registry] reaped ${row.shutdown} row with no engineSessionId (${row.appSessionId}): ` +
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
   *
   * **What a reap costs the peer plane, and why that is the ruling.** Dropping
   * a row does not drop its transcript, so the conversation comes back through
   * the catalog and can be reopened by hand — as a NEW row, with a new
   * `appSessionId`, a newly allocated `name`, and no `createdBy`. That is not a
   * bug to repair: PEER-SESSIONS §2 rules that a name is released on reap and
   * may be handed out again, which is only sound because identity is
   * row-scoped. Restoring a former name at reopen would have to reclaim a word
   * another live session may already be answering to. What the user reads as
   * the session's identity — its title — is preserved independently, by the
   * catalog-seeded `title` on the reopen path (`app/main/openHistorySession.ts`),
   * so the conversation keeps its label and only its peer address is new.
   *
   * **`peerWakeBlocked` is the exception, and it is why the sort is not plain
   * oldest-first.** Every other field here is machine-minted. That one is the
   * user's own standing answer about a conversation they can still see, and the
   * reap is the only thing that clears it without them (`setPeerWakeBlocked` is
   * reachable only from the sidebar row menu). Losing it silently converts a
   * recorded "no" into a "yes" at the moment the operator reopens the
   * transcript, so blocked rows sort LAST and are discarded only when nothing
   * else can satisfy the bound.
   *
   * Last, deliberately NOT exempt. `isReapableForBound` is shared with
   * `atBoundWithNothingReapable`, the HR4 predicate that refuses `peer.create`
   * when the registry is full with nothing to remove; excluding blocked rows
   * there would let a row-menu toggle, repeated, refuse peer creation outright.
   * The ordering keeps the bound and the churn rule exactly as they were.
   */
  private enforceBound(): string[] {
    if (this.doc.sessions.length <= MAX_REGISTRY_SESSIONS) return []

    const terminal = this.doc.sessions
      .filter(isReapableForBound)
      .sort(
        (a, b) =>
          Number(a.peerWakeBlocked === true) - Number(b.peerWakeBlocked === true) ||
          a.lastAttachedAt - b.lastAttachedAt,
      )
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
   * `setAdvisoryRuntime`, which never touches the counter).
   *
   * `engineSessionId` is seeded HERE when the spawn is a resume, and otherwise
   * stays null until the ready frame fills it (§4.5). Seeding is sound because
   * the sidecar pins the adopted id to the requested one
   * (`app/sidecar/sessionResume.ts` `sessionIdOverride`) and throws rather than
   * falling through to a fresh session, so the ready frame can only ever echo
   * the id we were handed (`app/sidecar/index.ts:124-126`). Waiting for that
   * echo is what made an opened history session warp: for the whole spawn
   * window its row had no engine id, so it could not be matched to its own
   * transcript and sorted to the top of the sidebar as brand-new activity.
   *
   * Returns the appSessionIds of any terminal rows reaped to make room (F5):
   * the host emits `session-removed` for them so a live subscriber's list
   * projection never keeps ghosts.
   */
  async upsertOnSpawn(input: {
    appSessionId: string
    cwd: string
    title?: string
    /** The id this spawn resumes, when it is a resume. New rows only: an
     * existing row already carries the id (restore/restart both require it). */
    engineSessionId?: string
    /**
     * Trusted branch provenance. Existing rows retain their value when omitted;
     * new rows default false for additive migration compatibility.
     */
    forked?: boolean
    /**
     * PEER-SESSIONS §2 — the peer name and creator for this spawn. Both are
     * WRITE-ONCE: an existing row keeps whatever it already has, so a restore
     * (which replays the row's own values) and a later re-spawn can never
     * rename a session or re-parent it. The host allocates a name and passes
     * it here exactly when the row has none.
     */
    name?: string
    createdBy?: string
    createdByName?: string
    enginePid?: number
    socketPath?: string
  }): Promise<string[]> {
    const now = Date.now()
    let reaped: string[] = []
    const existing = this.find(input.appSessionId)
    if (existing) {
      existing.cwd = input.cwd
      if (input.title !== undefined) {
        // Stamp ONLY a real change of intent: restore feeds the row's own title
        // straight back in (`host.ts:332`), and re-stamping that would make an
        // untouched title outrank a newer transcript rename on every reopen.
        if (input.title !== existing.title) existing.titleUpdatedAt = now
        existing.title = input.title
      }
      if (input.forked !== undefined) existing.forked = input.forked
      // Write-once (see the input doc): fill a gap, never replace a value. This
      // is what lets a row that predates the field gain its name on its next
      // spawn, create or restore without any migration.
      if (input.name !== undefined && existing.name === undefined) {
        existing.name = input.name
      }
      if (input.createdBy !== undefined && existing.createdBy === undefined) {
        existing.createdBy = input.createdBy
      }
      if (
        input.createdByName !== undefined &&
        existing.createdByName === undefined
      ) {
        existing.createdByName = input.createdByName
      }
      existing.enginePid = input.enginePid
      existing.socketPath = input.socketPath
      existing.lastAttachedAt = now
      existing.shutdown = null
      existing.restartCount = (existing.restartCount ?? 0) + 1
    } else {
      this.doc.sessions.push({
        appSessionId: input.appSessionId,
        engineSessionId: input.engineSessionId ?? null,
        cwd: input.cwd,
        ...(input.title !== undefined
          ? { title: input.title, titleUpdatedAt: now }
          : {}),
        forked: input.forked ?? false,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {}),
        ...(input.createdByName !== undefined
          ? { createdByName: input.createdByName }
          : {}),
        createdAt: now,
        lastAttachedAt: now,
        // CC-2: a fresh spawn has SENT nothing yet — attach/spawn must not fake
        // recency. Bumped only by `markMessageSent` on a real turn.
        lastMessageSentAt: null,
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
   * Give every RECENTLY-ACTIVE row that has no `name` one, in a SINGLE persist
   * (PEER-SESSIONS §2 — "every session is named"). Recent = attached within
   * `NAME_REPAIR_WINDOW_MS`. Returns the ids it named; when there is nothing to
   * name it writes nothing.
   *
   * WRITE-ONCE, exactly like the `name` handling in `upsertOnSpawn`: a row that
   * already carries a name is never renamed — at any age — so this is safe to
   * run at every launch. `allocate` is the HOST's picker, because allocation
   * policy belongs to the one process that sees every row (§2). It is called
   * once per row and AFTER the previous name is already on `this.doc`, so a
   * picker that reserves against the current rows widens its reserved set with
   * each assignment and cannot hand out a duplicate.
   *
   * Why a launch-time fill and not the next spawn (`upsertOnSpawn`): §2 assumed
   * an unnamed row is "a never-restored history row that cannot be a caller",
   * but a nameless row cannot be reached at all. `peersOf`
   * (`app/main/peerRequestPlane.ts:521`) drops rows without a name, so a closed
   * row cannot be listed, therefore cannot be woken, therefore never spawns
   * again — the only exit from namelessness is a door namelessness closes. And
   * `validateRow` below is a closed whitelist, so ANY build that predates a
   * field silently drops it from every row it loads and writes back: one launch
   * of a stale packaged app un-names the whole registry. This write repairs
   * both, and repairs them again after the next such launch.
   *
   * That same reasoning is why the window is a REPAIR bound and not a rule about
   * naming: it can only ever leave rows unnamed, never un-name one, and rows
   * created from here on are named at spawn regardless of it. A row it skips is
   * out of the peer world permanently, by the deliberate choice recorded on the
   * constant — not because a later pass will get to it.
   */
  async fillMissingNames(allocate: () => string): Promise<string[]> {
    const cutoff = Date.now() - NAME_REPAIR_WINDOW_MS
    const named: string[] = []
    for (const row of this.doc.sessions) {
      if (row.name !== undefined) continue
      if (row.lastAttachedAt < cutoff) continue
      row.name = allocate()
      named.push(row.appSessionId)
    }
    if (named.length === 0) return named
    await this.persist()
    return named
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
    await this.mutate('setAdvisoryRuntime', appSessionId, row => {
      row.enginePid = input.enginePid
      row.socketPath = input.socketPath
    })
  }

  /** Fill `engineSessionId` on the ready frame (the two-id bridge, §2/§4.5). */
  async fillEngineSessionId(appSessionId: string, engineSessionId: string): Promise<void> {
    await this.mutate('fillEngineSessionId', appSessionId, row => {
      row.engineSessionId = engineSessionId
      row.lastAttachedAt = Date.now()
    })
  }

  /**
   * Update the app-owned title on rename (§4.5), stamping `titleUpdatedAt` with
   * the moment this intent was recorded so the renderer can tell an app rename
   * from a newer engine-transcript rename (see `titleUpdatedAt` above).
   */
  async setTitle(appSessionId: string, title: string): Promise<void> {
    await this.mutate('setTitle', appSessionId, row => {
      row.title = title
      row.titleUpdatedAt = Date.now()
    })
  }

  /**
   * Set or clear the user's peer-wake block (PEER-SESSIONS §6). Returns false
   * when no row carries the id, so the host can answer `session_not_found`
   * (HC2) rather than persist nothing and report success.
   *
   * Clearing DELETES the key instead of storing `false`, so a cleared row and a
   * row that never had the flag are the same document — otherwise every clear
   * would leave a diff that `rowsEqual` reports as a change forever.
   */
  async setPeerWakeBlocked(appSessionId: string, blocked: boolean): Promise<boolean> {
    return this.mutate('setPeerWakeBlocked', appSessionId, row => {
      if (blocked) {
        row.peerWakeBlocked = true
      } else {
        delete row.peerWakeBlocked
      }
    })
  }

  /**
   * HOST-REQUEST-PLANE HR4 — is the registry full with nothing the bound-reap
   * could remove?
   *
   * `enforceBound` only ever removes TERMINAL, non-parked rows and removes fewer
   * than needed rather than refusing, so a caller that can create-park-create at
   * machine speed grows this file without limit: a parked row is neither live
   * (it leaves the host's live count) nor reapable (it is an open tab). A caller
   * subject to that rule asks this first and refuses instead. It lives here, not
   * in the host, so the eligibility test stays the SAME expression the reap uses
   * — two copies would drift the moment either changed.
   */
  atBoundWithNothingReapable(): boolean {
    if (this.doc.sessions.length < MAX_REGISTRY_SESSIONS) return false
    return !this.doc.sessions.some(isReapableForBound)
  }

  /** Heartbeat `lastAttachedAt` on attach (§4.5). */
  async touchAttached(appSessionId: string): Promise<void> {
    await this.mutate('touchAttached', appSessionId, row => {
      row.lastAttachedAt = Date.now()
    })
  }

  /**
   * Stamp `lastMessageSentAt` when this session actually SENT a message this run
   * (CC-2, `app/renderer/src/sidebarState.ts` deferred spec). This is the ONLY
   * write point for the field — deliberately NOT reached by `upsertOnSpawn`,
   * `touchAttached`, `setAdvisoryRuntime`, or any restore/attach path, so merely
   * OPENING a session never bumps the sidebar's recency. Called by `host.ts` off
   * a live (non-replay) turn-end frame.
   */
  async markMessageSent(appSessionId: string): Promise<void> {
    await this.mutate('markMessageSent', appSessionId, row => {
      row.lastMessageSentAt = Date.now()
    })
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
    await this.mutate('markCrashed', appSessionId, row => {
      if (row.shutdown !== null) return false
      row.shutdown = 'crashed'
    })
  }

  /**
   * IDLE-PARK (decisions/IDLE-PARK.md §2/§8) — mark a LIVE row `'parked'` when its
   * sidecar self-exited with `PARKED_EXIT_CODE` (host classifies on the exit code,
   * `host.onSupervisorEvent`). Only transitions rows with `shutdown === null`, the
   * SAME guard as `markCrashed`: a row already terminal (clean/crashed) keeps its
   * state, so a park can never relabel a genuine close or crash. Advisory runtime
   * fields are retained (an unpark re-spawns via the existing restore machinery).
   * The `'parked'` state lives only in the in-memory doc; it normalises to
   * `'crashed'` on the next disk read (`normalizeShutdown`).
   */
  async markParked(appSessionId: string): Promise<void> {
    await this.mutate('markParked', appSessionId, row => {
      if (row.shutdown !== null) return false
      row.shutdown = 'parked'
    })
  }

  /**
   * Mark `shutdown: "clean"` on graceful close (§4.5, inside killSession/
   * shutdown). The row is KEPT (restorable); advisory runtime fields are retained
   * so restore can refuse if the old writer did not actually die.
   */
  async markClean(appSessionId: string): Promise<void> {
    await this.mutate('markClean', appSessionId, row => {
      row.shutdown = 'clean'
    })
  }

  /**
   * The find / log-if-missing / persist ladder every single-row mutator above
   * repeats. `apply` returns false for a change the row does not need persisted
   * (the already-terminal early-outs in `markCrashed` and `markParked`);
   * anything else persists. The resolved boolean answers "was there a row",
   * which is what `setPeerWakeBlocked`'s caller turns into `session_not_found`
   * (HC2) rather than persisting nothing and reporting success.
   */
  private async mutate(
    label: string,
    appSessionId: string,
    apply: (row: RegistrySession) => boolean | void,
  ): Promise<boolean> {
    const row = this.find(appSessionId)
    if (!row) {
      this.log(`[registry] ${label}: no row for ${appSessionId}`)
      return false
    }
    if (apply(row) === false) return true
    await this.persist()
    return true
  }

  private find(appSessionId: string): RegistrySession | undefined {
    return this.doc.sessions.find(r => r.appSessionId === appSessionId)
  }

  /**
   * SYNCHRONOUS clean-marking for the exit path (B3 / die-with-window). Marks
   * every currently-live row (`shutdown == null`) clean, retaining advisory fields
   * for restore-time prior-writer checks, and writes ONCE atomically under the
   * synchronous advisory lock. This runs on `window-all-closed`/`before-quit`,
   * where the process may exit before an async persist could settle. A write
   * failure is swallowed (the row state is re-derivable; a launch sweep would
   * just mark them crashed instead).
   *
   * IDLE-PARK: `'parked'` rows are marked clean TOO, and that is not a widening
   * of "live". A park is a reclaim the host chose, so an ordinary quit that finds
   * one is an ordinary quit — not the app-crashed-while-parked case that
   * `normalizeShutdown`'s `'parked'` → `'crashed'` rule (§8) exists for. That
   * rule stays correct precisely because a real crash never runs this method.
   * Without this, every quit left parked rows `'parked'` on disk and the next
   * launch read them as `crashed`: under a TTL shorter than the gap between
   * visits, most background sessions are parked at any moment, so most of the
   * sidebar, the Sessions page and the palette came back dead-toned after an
   * ordinary relaunch (2026-09-02 assessment §3; three days of log hold 11
   * sidecar exits, all parks, and 0 crashes, against 53 `crashed` rows).
   * `'crashed'` is still never relabelled — a genuine crash keeps its state.
   * Returns the ids it marked.
   */
  markLiveCleanSync(): string[] {
    const marked: string[] = []
    for (const row of this.doc.sessions) {
      if (row.shutdown !== null && row.shutdown !== 'parked') continue
      row.shutdown = 'clean'
      marked.push(row.appSessionId)
    }
    if (marked.length === 0) return marked
    this.doc.hostPid = process.pid
    this.doc.updatedAt = Date.now()
    if (this.readFailed) {
      this.writeFailed = true
      this.log('[registry] markLiveCleanSync skipped because the registry could not be read this run')
      return marked
    }

    let release: (() => void) | undefined
    try {
      ensureDir(this.dir)
      release = this.acquireLockSync(this.path)
      const latest = readDocumentForMerge(this.path, this.readRegistryFile)
      const merged = mergeRegistryDocuments(
        latest,
        this.persistedDoc,
        this.doc,
      )
      merged.hostPid = process.pid
      merged.updatedAt = Date.now()
      atomicWriteJson(this.path, merged)
      this.doc = merged
      this.persistedDoc = cloneDocument(merged)
      this.writeFailed = false
    } catch (error) {
      this.writeFailed = true
      this.log(`[registry] markLiveCleanSync write failed (${errText(error)})`)
    } finally {
      try {
        release?.()
      } catch {
        // best-effort unlock during process teardown
      }
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
    if (this.readFailed) {
      this.writeFailed = true
      this.log('[registry] skipping write because the registry could not be read this run')
      return
    }

    this.doc.hostPid = process.pid
    this.doc.updatedAt = Date.now()

    try {
      ensureDir(this.dir)
    } catch (error) {
      this.writeFailed = true
      this.log(
        `[registry] could not ensure ${this.dir} (${errText(error)}); ` +
          'skipping this write, session unaffected',
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
          'skipping this write, session unaffected',
      )
      return
    }

    let latest: RegistryDocument
    try {
      latest = readDocumentForMerge(this.path, this.readRegistryFile)
    } catch (error) {
      this.writeFailed = true
      this.readFailed = true
      this.log(
        `[registry] could not read current registry for merge (${errText(error)}); ` +
          'preserving the existing file for this run',
      )
      try {
        await release()
      } catch {
        // best-effort unlock
      }
      return
    }

    try {
      // The lock prevents torn writes, but not stale snapshots. Apply only this
      // instance's delta since its last successful persist so concurrent writers
      // retain each other's unrelated rows instead of last-writer-wins replacing
      // the whole file.
      const merged = mergeRegistryDocuments(
        latest,
        this.persistedDoc,
        this.doc,
      )
      merged.hostPid = process.pid
      merged.updatedAt = Date.now()
      atomicWriteJson(this.path, merged)
      this.doc = merged
      this.persistedDoc = cloneDocument(merged)
      this.writeFailed = false
    } catch (error) {
      this.writeFailed = true
      this.log(`[registry] could not merge and persist registry (${errText(error)}); session unaffected`)
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

/**
 * May the bound-reap drop this row? Live rows (`shutdown === null`) never, and
 * IDLE-PARK (decisions/IDLE-PARK.md §8) exempts `'parked'` too: a parked row is
 * an OPEN tab whose engine was reclaimed, not a terminal row, so reaping it
 * would dangle the tab. The single expression behind both `enforceBound` and
 * `atBoundWithNothingReapable` (HOST-REQUEST-PLANE HR4), which must agree.
 */
function isReapableForBound(row: RegistrySession): boolean {
  return row.shutdown !== null && row.shutdown !== 'parked'
}

function emptyDoc(): RegistryDocument {
  return {
    registryVersion: REGISTRY_VERSION,
    hostPid: process.pid,
    updatedAt: Date.now(),
    sessions: [],
  }
}

function cloneDocument(doc: RegistryDocument): RegistryDocument {
  return {
    ...doc,
    sessions: doc.sessions.map(row => ({ ...row })),
  }
}

/** Read a valid current document for a locked merge, never a recovery fallback. */
function readDocumentForMerge(
  filePath: string,
  reader: (path: string) => string,
): RegistryDocument {
  if (!existsSync(filePath)) return emptyDoc()
  const validated = validateDocument(JSON.parse(reader(filePath)))
  if (!validated) {
    throw new Error('registry document is malformed or has an unknown version')
  }
  return validated
}

/**
 * Apply only local changes since `baseline` to a newly read disk document.
 * This is intentionally row-oriented: another host may have written a new
 * session while this instance was waiting for the advisory lock.
 */
function mergeRegistryDocuments(
  latest: RegistryDocument,
  baseline: RegistryDocument,
  local: RegistryDocument,
): RegistryDocument {
  const baselineById = new Map(
    baseline.sessions.map(row => [row.appSessionId, row]),
  )
  const localById = new Map(local.sessions.map(row => [row.appSessionId, row]))
  const mergedById = new Map(
    latest.sessions.map(row => [row.appSessionId, { ...row }]),
  )

  // A row that existed in our baseline but is absent locally was deliberately
  // reaped. Preserve that removal even when another writer touched other rows.
  for (const appSessionId of baselineById.keys()) {
    if (!localById.has(appSessionId)) mergedById.delete(appSessionId)
  }

  for (const [appSessionId, localRow] of localById) {
    const baselineRow = baselineById.get(appSessionId)
    const latestRow = mergedById.get(appSessionId)
    if (baselineRow && rowsEqual(localRow, baselineRow)) {
      // `'parked'` is intentionally normalised to `'crashed'` on a NEW
      // launch, but this read is part of the same live process's write merge.
      // Preserve its in-memory-only meaning until that process exits.
      if (baselineRow.shutdown === 'parked' && latestRow) {
        mergedById.set(appSessionId, { ...latestRow, shutdown: 'parked' })
      }
      continue
    }

    mergedById.set(
      appSessionId,
      latestRow
        ? mergeRegistryRow(latestRow, localRow, baselineRow)
        : { ...localRow },
    )
  }

  return {
    ...latest,
    sessions: [...mergedById.values()],
  }
}

function rowsEqual(left: RegistrySession, right: RegistrySession): boolean {
  return (
    left.appSessionId === right.appSessionId &&
    left.engineSessionId === right.engineSessionId &&
    left.cwd === right.cwd &&
    left.title === right.title &&
    left.forked === right.forked &&
    left.name === right.name &&
    left.createdBy === right.createdBy &&
    left.createdByName === right.createdByName &&
    left.peerWakeBlocked === right.peerWakeBlocked &&
    left.titleUpdatedAt === right.titleUpdatedAt &&
    left.createdAt === right.createdAt &&
    left.lastAttachedAt === right.lastAttachedAt &&
    left.lastMessageSentAt === right.lastMessageSentAt &&
    left.shutdown === right.shutdown &&
    left.enginePid === right.enginePid &&
    left.socketPath === right.socketPath &&
    left.restartCount === right.restartCount
  )
}

/** Merge concurrent edits to one row without rolling a newer attachment back. */
function mergeRegistryRow(
  latest: RegistrySession,
  local: RegistrySession,
  baseline: RegistrySession | undefined,
): RegistrySession {
  const useLocalRuntime = local.lastAttachedAt >= latest.lastAttachedAt
  const runtime = useLocalRuntime ? local : latest
  const useLocalTitle =
    (local.titleUpdatedAt ?? Number.NEGATIVE_INFINITY) >=
    (latest.titleUpdatedAt ?? Number.NEGATIVE_INFINITY)
  const titleSource = useLocalTitle ? local : latest
  // Provenance is durable, not a runtime hint. If this writer did not change it
  // from its baseline, preserve a concurrent writer's newer trusted value.
  const forked =
    baseline && local.forked === baseline.forked ? latest.forked : local.forked
  // The three peer fields are durable identity/intent, not runtime hints, so they
  // follow the `forked` rule: a writer that did not change a field from its own
  // baseline must not roll back a concurrent writer's newer value. That is what
  // keeps an allocated name and a user-set wake block from being lost when
  // another host writes an unrelated row between our read and our write.
  const name =
    baseline && local.name === baseline.name ? latest.name : local.name
  const createdBy =
    baseline && local.createdBy === baseline.createdBy
      ? latest.createdBy
      : local.createdBy
  const createdByName =
    baseline && local.createdByName === baseline.createdByName
      ? latest.createdByName
      : local.createdByName
  const peerWakeBlocked =
    baseline && local.peerWakeBlocked === baseline.peerWakeBlocked
      ? latest.peerWakeBlocked
      : local.peerWakeBlocked

  return {
    appSessionId: local.appSessionId,
    engineSessionId: runtime.engineSessionId,
    cwd: runtime.cwd,
    ...(titleSource.title !== undefined ? { title: titleSource.title } : {}),
    ...(titleSource.titleUpdatedAt !== undefined
      ? { titleUpdatedAt: titleSource.titleUpdatedAt }
      : {}),
    forked,
    ...(name !== undefined ? { name } : {}),
    ...(createdBy !== undefined ? { createdBy } : {}),
    ...(createdByName !== undefined ? { createdByName } : {}),
    ...(peerWakeBlocked ? { peerWakeBlocked } : {}),
    createdAt: Math.min(latest.createdAt, local.createdAt),
    lastAttachedAt: Math.max(latest.lastAttachedAt, local.lastAttachedAt),
    lastMessageSentAt: maxNullableTimestamp(
      latest.lastMessageSentAt,
      local.lastMessageSentAt,
    ),
    shutdown: runtime.shutdown,
    ...(runtime.enginePid !== undefined ? { enginePid: runtime.enginePid } : {}),
    ...(runtime.socketPath !== undefined
      ? { socketPath: runtime.socketPath }
      : {}),
    restartCount: Math.max(latest.restartCount ?? 0, local.restartCount ?? 0),
  }
}

function maxNullableTimestamp(
  left: number | null,
  right: number | null,
): number | null {
  if (left === null) return right
  if (right === null) return left
  return Math.max(left, right)
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
    // Additive migration: rows written before branch provenance existed are
    // ordinary sessions.
    forked: candidate.forked === true,
    createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now(),
    lastAttachedAt:
      typeof candidate.lastAttachedAt === 'number' ? candidate.lastAttachedAt : Date.now(),
    // CC-2: null default for pre-existing rows written before the field existed.
    lastMessageSentAt:
      typeof candidate.lastMessageSentAt === 'number' ? candidate.lastMessageSentAt : null,
    shutdown,
  }
  if (typeof candidate.title === 'string') row.title = candidate.title
  // PEER-SESSIONS §2 — additive migration, the `forked` treatment: a row written
  // before peer names existed simply has none, and `fillMissingNames` gives it
  // one at the next launch — if it was attached inside `NAME_REPAIR_WINDOW_MS`;
  // older rows deliberately stay nameless. NOTE this reconstruction is a closed
  // WHITELIST in both directions: a build that predates a field drops it from every row it
  // loads and writes the stripped row back, so a field added here is not durable
  // against an older binary the user can still launch. That is why the name fill
  // runs at every launch and not only on a row's next spawn.
  if (typeof candidate.name === 'string') row.name = candidate.name
  if (typeof candidate.createdBy === 'string') row.createdBy = candidate.createdBy
  if (typeof candidate.createdByName === 'string')
    row.createdByName = candidate.createdByName
  // Absent ⇒ false (PEER-SESSIONS §6). Only `true` is stored, so an old row and a
  // row the user cleared are byte-identical on disk.
  if (candidate.peerWakeBlocked === true) row.peerWakeBlocked = true
  // Absent on rows written before the field existed → "never stamped", which the
  // renderer reads as 0, so a real transcript title wins and a terminal rename
  // made before this shipped still surfaces.
  if (typeof candidate.titleUpdatedAt === 'number') {
    row.titleUpdatedAt = candidate.titleUpdatedAt
  }
  if (typeof candidate.enginePid === 'number') row.enginePid = candidate.enginePid
  if (typeof candidate.socketPath === 'string') row.socketPath = candidate.socketPath
  if (typeof candidate.restartCount === 'number') row.restartCount = candidate.restartCount
  return row
}

function normalizeShutdown(value: unknown): ShutdownState {
  if (value === 'clean' || value === 'crashed') return value
  // IDLE-PARK (decisions/IDLE-PARK.md §8): `'parked'` is an in-memory-only state
  // for a LIVE run. If it ever survives to disk (the app crashed while a session
  // was parked), treat it next launch as an ordinary crashed restore-offer — a
  // parked engine has no live process to reattach to, exactly like a crash.
  if (value === 'parked') return 'crashed'
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
  lockSync: (
    file: string,
    options?: {
      realpath?: boolean
      stale?: number
    },
  ) => () => void
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

function defaultAcquireLockSync(file: string): () => void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const lockfile = require('proper-lockfile') as ProperLockfile
  return lockfile.lockSync(file, {
    realpath: false,
    stale: 20_000,
  })
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
