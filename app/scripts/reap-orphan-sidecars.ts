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
 *  - A process is an orphan candidate ONLY when its command line matches the
 *    sidecar entry AND its parent is dead (reparented to PID 1, or its PPID is
 *    no longer alive). Never matched on pid alone; a sidecar whose parent
 *    (Electron/supervisor) is still alive is left untouched.
 *  - DRY-RUN by default: it prints what it WOULD do and exits 0. Pass `--confirm`
 *    to actually SIGTERM the orphans and remove the stale socket dirs.
 *  - Stale `/tmp/catcode-<pid>` socket dirs are removed only when `<pid>` (the
 *    supervisor pid that owns the dir) is dead.
 *
 * Usage:
 *   bun run app/scripts/reap-orphan-sidecars.ts             # dry run (list only)
 *   bun run app/scripts/reap-orphan-sidecars.ts --confirm   # SIGTERM + remove dirs
 *   bun run app/scripts/reap-orphan-sidecars.ts --marker <substr>   # override cmdline marker (packaged binary)
 *
 * Electron-free; no new dependencies (node:child_process + node:fs only).
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Default cmdline marker: the dev sidecar entry. Override for packaged builds. */
const DEFAULT_MARKER = 'app/sidecar/index.ts'

type OrphanProc = { pid: number; ppid: number; command: string }
type StaleDir = { path: string; pid: number }

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

/** All processes whose command line contains `marker` (via `ps`, no shell). */
function listMatchingProcesses(marker: string): OrphanProc[] {
  let raw: string
  try {
    raw = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    })
  } catch (error) {
    throw new Error(`could not run ps: ${errText(error)}`)
  }
  const self = process.pid
  const matches: OrphanProc[] = []
  for (const line of raw.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
    if (!m) continue
    const pid = Number(m[1])
    const ppid = Number(m[2])
    const command = m[3] ?? ''
    if (pid === self) continue // never match this script
    if (!command.includes(marker)) continue
    matches.push({ pid, ppid, command })
  }
  return matches
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

  const procs = listMatchingProcesses(marker)
  const { orphans, adopted } = partitionOrphans(procs)
  const staleDirs = listStaleSocketDirs()

  console.log(`\nOrphaned-sidecar cleanup (marker: "${marker}")`)
  console.log('─'.repeat(64))
  console.log(
    `matched ${procs.length} sidecar process(es): ${orphans.length} orphaned, ` +
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

main()
