/**
 * One-shot orphaned-sidecar cleanup (CC-3, docs O1 / SESSION-LIFETIME §2).
 *
 * The desktop app runs one Bun engine sidecar per session. Sidecars deliberately
 * survive parent death (die-with-window is supervisor behavior, not process
 * welding — SESSION-LIFETIME L2), so a host crash or a killed dev/GUI harness
 * leaves the sidecar running with no reaper until the next app launch — and none
 * at all if its registry row was evicted first (docs O1). This script enumerates
 * the current orphan fleet and, on confirmation, terminates it.
 *
 * SAFETY:
 *  - A process is an orphan candidate ONLY when its pid and socket path appear
 *    in the desktop registry as a still-live row, its command line confirms the
 *    sidecar entry, AND its parent is dead (reparented to PID 1, or its PPID is
 *    no longer alive). A marker never discovers processes on its own.
 *  - DRY-RUN by default: it prints what it WOULD do and exits 0. Pass `--confirm`
 *    to actually SIGTERM the orphans and remove the stale socket dirs.
 *  - Stale `/tmp/catcode-<pid>` socket dirs are removed only when `<pid>` (the
 *    supervisor pid that owns the dir) is dead.
 *
 * Usage:
 *   bun run app/scripts/reap-orphan-sidecars.ts             # dry run (list only)
 *   bun run app/scripts/reap-orphan-sidecars.ts --confirm   # SIGTERM + remove dirs
 *   bun run app/scripts/reap-orphan-sidecars.ts --marker <substr>   # identity marker for recorded pids only
 *
 * Electron-free; no new dependencies (node:child_process + node:fs only).
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultRegistryDir, REGISTRY_VERSION } from '../host/registry.js'

/**
 * Default cmdline marker: the dev sidecar entry.
 *
 * For a packaged build the equivalent is the session mode's launch string,
 * `<bundle>/Contents/Resources/sidecar/cat-code-sidecar session` — the same
 * value `resolveSidecarLaunch` hands the registry as its identity marker. Pass
 * it explicitly; the mode token is load-bearing, because without it the marker
 * also matches the disposable workers.
 */
const DEFAULT_MARKER = 'app/sidecar/index.ts'

export type OrphanProc = {
  pid: number
  ppid: number
  command: string
  socketPath: string
}
type StaleDir = { path: string; pid: number }

type RegistryCandidate = {
  shutdown: unknown
  enginePid: unknown
  socketPath: unknown
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // ESRCH → gone; EPERM → alive but not ours (conservative: treat as alive so
    // we never claim a foreign process is dead and reap its socket dir).
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The reaper may only consider sidecars the desktop itself recorded as live.
 * A marker is an identity CONFIRMATION, never a way to discover arbitrary
 * processes. This is deliberately a narrow read-only parser: an unreadable or
 * malformed registry produces no candidates, which is safer than a machine-wide
 * process scan.
 */
export function ownedSidecarCandidatesFromRegistry(raw: string): Array<{
  pid: number
  socketPath: string
}> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('registryVersion' in parsed) ||
    parsed.registryVersion !== REGISTRY_VERSION ||
    !('sessions' in parsed) ||
    !Array.isArray(parsed.sessions)
  ) {
    return []
  }
  return parsed.sessions.flatMap(session => {
    if (session === null || typeof session !== 'object') return []
    const candidate = session as RegistryCandidate
    // `shutdown: null` is the durable "host died before cleanup" marker. A
    // clean/terminal row's advisory pid is history, not kill authority.
    if (
      candidate.shutdown !== null ||
      typeof candidate.enginePid !== 'number' ||
      !Number.isInteger(candidate.enginePid) ||
      candidate.enginePid <= 1 ||
      typeof candidate.socketPath !== 'string' ||
      candidate.socketPath.length === 0
    ) {
      return []
    }
    return [{ pid: candidate.enginePid, socketPath: candidate.socketPath }]
  })
}

function readOwnedSidecarCandidates(): Array<{ pid: number; socketPath: string }> {
  try {
    return ownedSidecarCandidatesFromRegistry(
      readFileSync(join(defaultRegistryDir(), 'registry.json'), 'utf8'),
    )
  } catch {
    return []
  }
}

/** Read one owned pid's parent and command. Never enumerate machine processes. */
function inspectOwnedProcess(pid: number): { ppid: number; command: string } | null {
  try {
    const raw = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024,
    }).trim()
    const match = raw.match(/^(\d+)\s+(.*)$/)
    if (!match) return null
    return { ppid: Number(match[1]), command: match[2] ?? '' }
  } catch {
    return null
  }
}

/**
 * Partition matching sidecars into orphans (parent dead) and adopted (parent
 * still alive — left untouched). Orphan = PPID 1 (reparented to init) OR a PPID
 * that is no longer alive. Never kill on pid-match alone (docs O1 / §9-A3 spirit).
 */
function partitionOrphans(procs: OrphanProc[]): {
  orphans: OrphanProc[]
  adopted: OrphanProc[]
} {
  const orphans: OrphanProc[] = []
  const adopted: OrphanProc[] = []
  for (const proc of procs) {
    const parentDead = proc.ppid === 1 || !isProcessAlive(proc.ppid)
    if (parentDead) orphans.push(proc)
    else adopted.push(proc)
  }
  return { orphans, adopted }
}

function listOwnedOrphanCandidates(marker: string): OrphanProc[] {
  const self = process.pid
  return readOwnedSidecarCandidates().flatMap(candidate => {
    if (candidate.pid === self || !existsSync(candidate.socketPath)) return []
    const process = inspectOwnedProcess(candidate.pid)
    if (process === null || !process.command.includes(marker)) return []
    return [{ ...candidate, ...process }]
  })
}

/** `/tmp/catcode-<pid>` supervisor socket dirs whose owning pid is dead. */
function listStaleSocketDirs(): StaleDir[] {
  const base = process.platform === 'win32' ? (process.env.TEMP ?? 'C:\\Temp') : tmpdir()
  // The supervisor defaults its socketDir to `/tmp/catcode-<pid>` on POSIX
  // (supervisor.ts) — tmpdir() is `/tmp` there; keep the same base so the two
  // agree. On macOS tmpdir() is /var/folders/… (not where sidecars live), so
  // scan /tmp explicitly on POSIX.
  const scanDirs = process.platform === 'win32' ? [base] : ['/tmp']
  const stale: StaleDir[] = []
  for (const dir of scanDirs) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      const m = name.match(/^catcode-(\d+)$/)
      if (!m) continue
      const path = join(dir, name)
      try {
        if (!statSync(path).isDirectory()) continue
      } catch {
        continue
      }
      const pid = Number(m[1])
      if (!isProcessAlive(pid)) stale.push({ path, pid })
    }
  }
  return stale
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function truncate(text: string, max = 100): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function main(): void {
  const argv = process.argv.slice(2)
  const confirm = argv.includes('--confirm')
  const markerIdx = argv.indexOf('--marker')
  const marker = markerIdx >= 0 && argv[markerIdx + 1] ? argv[markerIdx + 1]! : DEFAULT_MARKER

  const procs = listOwnedOrphanCandidates(marker)
  const { orphans, adopted } = partitionOrphans(procs)
  const staleDirs = listStaleSocketDirs()

  console.log(`\nOrphaned-sidecar cleanup (marker: "${marker}")`)
  console.log('─'.repeat(64))
  console.log(
    `matched ${procs.length} registry-owned sidecar process(es): ${orphans.length} orphaned, ` +
      `${adopted.length} with a live parent (kept).`,
  )

  if (adopted.length > 0) {
    console.log(`\nKEPT (parent alive — never reaped):`)
    for (const p of adopted) console.log(`  pid=${p.pid} ppid=${p.ppid}`)
  }

  if (orphans.length > 0) {
    console.log(`\nORPHANS (parent dead) — ${confirm ? 'SIGTERM' : 'would SIGTERM'}:`)
    for (const p of orphans) {
      console.log(`  pid=${p.pid} ppid=${p.ppid}  ${truncate(p.command)}`)
    }
  } else {
    console.log(`\nNo orphaned sidecars found.`)
  }

  if (staleDirs.length > 0) {
    console.log(`\nSTALE SOCKET DIRS (owning pid dead) — ${confirm ? 'removing' : 'would remove'}:`)
    for (const d of staleDirs) console.log(`  ${d.path} (pid ${d.pid} dead)`)
  } else {
    console.log(`\nNo stale /tmp/catcode-* socket dirs found.`)
  }

  if (!confirm) {
    console.log('\n' + '─'.repeat(64))
    console.log('DRY RUN — nothing was killed or removed.')
    console.log('Re-run with --confirm to SIGTERM the orphans and remove the stale dirs.')
    return
  }

  console.log('\n' + '─'.repeat(64))
  let killed = 0
  for (const p of orphans) {
    try {
      process.kill(p.pid, 'SIGTERM')
      killed++
      console.log(`  SIGTERM pid=${p.pid} ✓`)
    } catch (error) {
      console.log(`  SIGTERM pid=${p.pid} FAILED: ${errText(error)}`)
    }
  }
  let removed = 0
  for (const d of staleDirs) {
    try {
      rmSync(d.path, { recursive: true, force: true })
      removed++
      console.log(`  removed ${d.path} ✓`)
    } catch (error) {
      console.log(`  remove ${d.path} FAILED: ${errText(error)}`)
    }
  }
  console.log(`\nDone: SIGTERM'd ${killed}/${orphans.length} orphan(s), removed ${removed}/${staleDirs.length} stale dir(s).`)
}

if (import.meta.main) main()
