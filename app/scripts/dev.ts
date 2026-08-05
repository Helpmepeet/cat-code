/**
 * Dev launcher: build main+preload, start the Vite renderer dev server, then
 * launch Electron pointed at it. Ctrl-C tears all three down.
 *
 * `bun run dev` (from app/) is the day-to-day entrypoint.
 *
 * Every supervision DECISION lives in `devLauncher.ts` (pure, tested); this file
 * is the wiring. The launcher owns two child lifetimes, so it must: notice a
 * child that dies, never accept readiness from a server it does not own, wait
 * for both children to actually go away, and exit with a status that reflects
 * what happened.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { prepareDevElectron } from './prepare-dev-electron.js'
import {
  describeChildExit,
  describeReadinessFailure,
  isCleanExit,
  resolveLauncherExitCode,
  terminateChild,
  waitForRendererReady,
  type ChildExit,
} from './devLauncher.js'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')

const RENDERER_URL = 'http://localhost:5173'
const READY_TIMEOUT_MS = 15_000
const READY_POLL_MS = 200
/** How long a child gets to honour SIGTERM before SIGKILL. */
const TERMINATE_GRACE_MS = 5_000
const TERMINATE_POLL_MS = 100

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

/**
 * A spawned child plus the exit we observed. `exit` stays null while it runs;
 * a spawn `error` (bad path, EACCES) is recorded as an exit too, because to
 * every caller here it means the same thing: this child will never be usable.
 */
type Supervised = {
  name: string
  child: ChildProcess
  exit: ChildExit | null
}

function supervise(name: string, child: ChildProcess): Supervised {
  const supervised: Supervised = { name, child, exit: null }
  child.on('exit', (code, signal) => {
    supervised.exit ??= { code, signal }
  })
  child.on('error', error => {
    console.error(`[dev] ${name} failed to start:`, error)
    supervised.exit ??= { code: 1, signal: null }
  })
  return supervised
}

function stop(supervised: Supervised): Promise<unknown> {
  return terminateChild({
    kill: signal => supervised.child.kill(signal),
    hasExited: () => supervised.exit !== null,
    sleep,
    now: () => Date.now(),
    graceMs: TERMINATE_GRACE_MS,
    pollMs: TERMINATE_POLL_MS,
  })
}

// Rebranded copy so the Dock shows "Cat Code Dev" instead of "Electron"
// (see prepare-dev-electron.ts); falls back to the stock binary on any
// platform/failure where rebranding doesn't apply.
let electronBin: string
try {
  electronBin =
    prepareDevElectron() ?? join(appRoot, 'node_modules', '.bin', 'electron')
} catch (err) {
  console.warn('[dev] electron rebrand failed, using stock binary:', err)
  electronBin = join(appRoot, 'node_modules', '.bin', 'electron')
}

// 1. Build main + preload bundles.
const build = spawnSync('bun', ['run', join(here, 'build-electron.ts')], {
  stdio: 'inherit',
})
if (build.status !== 0) process.exit(build.status ?? 1)

// 2. Start Vite.
const vite = supervise(
  '(vite)',
  spawn('bunx', ['vite', '--config', join(appRoot, 'renderer', 'vite.config.ts')], {
    stdio: 'inherit',
    cwd: appRoot,
  }),
)

// 3. Wait for OUR Vite to be reachable, then launch Electron.
const readiness = await waitForRendererReady({
  probe: async () => {
    try {
      await fetch(RENDERER_URL)
      return true
    } catch {
      return false
    }
  },
  childExit: () => vite.exit,
  now: () => Date.now(),
  sleep,
  timeoutMs: READY_TIMEOUT_MS,
  pollMs: READY_POLL_MS,
})

if (!readiness.ok) {
  console.error(describeReadinessFailure(readiness, RENDERER_URL))
  await stop(vite)
  process.exit(1)
}

const electron = supervise(
  '(electron)',
  spawn(electronBin, ['.'], {
    stdio: 'inherit',
    cwd: appRoot,
    env: { ...process.env, CATCODE_RENDERER_URL: RENDERER_URL },
  }),
)

let shuttingDown = false

/**
 * Tear down both children and exit. Re-entrant by design: the operator's second
 * Ctrl-C, and Electron's own exit event firing mid-teardown, both land here.
 */
async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  await Promise.all([stop(electron), stop(vite)])
  process.exit(exitCode)
}

// Electron quitting is the normal end of a dev run — its status is the run's
// status, so a main-process crash at startup can no longer be read as success.
electron.child.on('exit', (code, signal) => {
  const exit: ChildExit = { code, signal }
  // Only when it ended on its OWN: a teardown we started signalled it, so its
  // non-zero status there is the expected outcome, not something to report.
  if (!shuttingDown && !isCleanExit(exit)) {
    console.error(`[dev] ${describeChildExit(electron.name, exit)}`)
  }
  void shutdown(resolveLauncherExitCode(exit))
})

// A child that never started may emit `error` WITHOUT `exit`, so the exit
// handler above is not guaranteed to run; without this the launcher would wait
// forever with Vite still up.
electron.child.on('error', () => {
  void shutdown(1)
})

// Vite dying after readiness leaves Electron pointed at nothing. Tear the run
// down rather than leave a window that can no longer load the renderer.
vite.child.on('exit', (code, signal) => {
  if (shuttingDown) return
  console.error(`[dev] ${describeChildExit(vite.name, { code, signal })}`)
  void shutdown(1)
})

// A signalled launcher reports the signal in its own status (128 + signum), so
// a wrapping script can tell an interrupted run from a failed one.
process.on('SIGINT', () => {
  void shutdown(resolveLauncherExitCode({ code: null, signal: 'SIGINT' }))
})
process.on('SIGTERM', () => {
  void shutdown(resolveLauncherExitCode({ code: null, signal: 'SIGTERM' }))
})
