/**
 * Prove the built application is self-contained (P5-1).
 *
 *   bun run --cwd app package && bun run --cwd app smoke:packaged
 *
 * Two parts, both credential-free:
 *
 *   A. The compiled sidecar runs with `bun` absent from PATH and a working
 *      directory outside the repository. This is the assertion that matters
 *      most, because development resolves `bun` from PATH and launches
 *      repository TypeScript: if either dependency survived packaging, the
 *      spawns below fail.
 *   B. The packaged application launches, takes the packaged branch it was not
 *      forced into, and loads its renderer from disk while a development
 *      renderer URL is deliberately set in its environment.
 *
 * What this does NOT cover is the live interaction Phase 5 leaves to the
 * operator: two real sessions, a tool call, a permission round-trip, and a
 * session switch. Those need credentials and a visible window; the exact steps
 * are printed at the end of a passing run.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveSidecarLaunch } from '../main/mainDecisions.js'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')
const bundle = join(appRoot, 'dist-app', 'Cat Code.app')
const contents = join(bundle, 'Contents')
const executable = join(contents, 'MacOS', 'Cat Code')

/**
 * Resolved through the SAME function the packaged app uses, never a literal
 * path. A hardcoded path here would let a wrong `PACKAGED_SIDECAR_BINARY`, a
 * wrong resources derivation, or mode-token drift between `SIDECAR_MODE_ENTRIES`
 * and `packagedEntry.ts` pass every assertion below.
 */
const launchPlan = resolveSidecarLaunch({
  packaged: true,
  mainDir: join(contents, 'Resources', 'app', 'main'),
  resourcesPath: join(contents, 'Resources'),
})
const sidecar = launchPlan.command

/**
 * A PATH with no `bun` on it. `bun` lives in `~/.bun/bin` here, so the system
 * directories alone are the honest "a user who never installed Bun" case.
 */
const NO_BUN_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

let failed = 0
function assert(condition: boolean, label: string, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failed += 1
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
}

if (!existsSync(bundle)) {
  process.stderr.write(
    `[packaged-launch-smoke] no bundle at ${bundle}\n` +
      "[packaged-launch-smoke] run 'bun run --cwd app package' first\n",
  )
  process.exit(3)
}

/**
 * Scratch homes so nothing here can reach the operator's ~/.cat-code. Removed on
 * exit rather than at the end of the happy path: a throw anywhere below (a
 * missing executable, a spawn failure) would otherwise leave them behind.
 */
const scratchDirs: string[] = []
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}
process.on('exit', () => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

const configHome = scratch('catcode-packaged-config-')
const workDir = scratch('catcode-packaged-cwd-')

console.log('A. compiled sidecar, no bun on PATH, outside the checkout')

// A1 — the engine graph really is inside the binary. Without socket env the
// sidecar hits its own startup guard, and the stack frame names the embedded
// filesystem rather than a .ts file in the repository.
const guard = spawnSync(sidecar, launchPlan.argsFor('session'), {
  encoding: 'utf8',
  cwd: workDir,
  env: { PATH: NO_BUN_PATH, HOME: configHome },
  timeout: 60_000,
})
const guardText = `${guard.stdout ?? ''}${guard.stderr ?? ''}`
assert(
  guardText.includes('sidecar requires CATCODE_SIDECAR_SOCKET'),
  'session mode reaches its own startup guard',
  guardText.slice(0, 400),
)
assert(
  guardText.includes('/$bunfs/root/'),
  'sidecar runs from the embedded filesystem, not repository TypeScript',
  guardText.slice(0, 400),
)

// A2 — the mode dispatcher fails closed on an unknown mode.
const unknown = spawnSync(sidecar, ['not-a-mode'], {
  encoding: 'utf8',
  cwd: workDir,
  env: { PATH: NO_BUN_PATH, HOME: configHome },
  timeout: 60_000,
})
assert(unknown.status === 1, 'unknown mode exits non-zero')
assert(
  `${unknown.stderr ?? ''}`.includes('unknown mode'),
  'unknown mode names the closed set',
  `${unknown.stderr ?? ''}`.slice(0, 200),
)

// A3 — a mode that does real engine work, end to end. debug-cleanup imports the
// engine's cleanup path and writes its marker, so a pass here means the bundled
// engine graph EXECUTES, not merely that an argument guard fired.
const markerDir = scratch('catcode-packaged-marker-')
const cleanup = spawnSync(sidecar, launchPlan.argsFor('debug-cleanup'), {
  encoding: 'utf8',
  cwd: workDir,
  env: {
    PATH: NO_BUN_PATH,
    HOME: configHome,
    CLAUDE_CONFIG_DIR: configHome,
    CATCODE_DEBUG_CLEANUP_MARKER_DIR: markerDir,
  },
  timeout: 120_000,
})
assert(cleanup.status === 0, 'debug-cleanup mode exits clean', `${cleanup.stderr ?? ''}`.slice(0, 400))
assert(
  existsSync(join(markerDir, 'debug-cleanup.last-run')),
  'debug-cleanup mode ran the bundled engine and wrote its marker',
)

// A4 — the catalog mode, which is the one with a load-ORDER hazard: it sets
// CLAUDE_CODE_SIMPLE at module scope before importing the engine graph, and the
// packaged entry keeps that working only because its dispatch imports lazily. A
// static dispatch would load the live-session machinery first and this emits
// nothing.
const catalogHome = scratch('catcode-packaged-catalog-')
const catalog = spawnSync(sidecar, launchPlan.argsFor('catalog', ['--bare']), {
  encoding: 'utf8',
  cwd: workDir,
  env: { PATH: NO_BUN_PATH, HOME: catalogHome, CLAUDE_CONFIG_DIR: catalogHome },
  timeout: 180_000,
})
assert(
  catalog.status === 0 && `${catalog.stdout ?? ''}`.includes('"type":"catalog"'),
  'catalog mode enumerates and emits its record',
  `${catalog.stdout ?? ''}${catalog.stderr ?? ''}`.slice(0, 400),
)

console.log('B. packaged application launch')

/**
 * There is no injected harness here, and that is a finding rather than a
 * shortcut: Electron ignores Node CLI options and `NODE_OPTIONS` in a packaged
 * app, so the `--require` trick `run-hardening-smoke.ts` uses against the
 * source tree cannot work against a real `.app`. The assertions below read
 * production main's OWN stdout instead, which is stronger evidence anyway —
 * nothing in the test can force the value it is checking.
 */
const app = Bun.spawn([executable], {
  cwd: workDir,
  env: {
    PATH: NO_BUN_PATH,
    HOME: configHome,
    CLAUDE_CONFIG_DIR: configHome,
    // Deliberate trap: a packaged build must ignore this and load from disk.
    // Main prints a named warning when it does, which is assertion B2.
    CATCODE_RENDERER_URL: 'http://127.0.0.1:59999',
  },
  stdout: 'pipe',
  stderr: 'pipe',
})
console.log(`  (launched pid ${app.pid})`)

/**
 * Read both streams until the readiness marker appears or the deadline passes.
 * The marker can land on either stream, so completion is signalled once and
 * shared rather than awaited per-stream: waiting for BOTH readers would always
 * burn the full deadline, since the quiet stream never sees the marker.
 *
 * Output accumulates into `launchLog` and the readers keep running after the
 * marker resolves this promise. A snapshot returned here instead would miss
 * everything the app prints afterwards, which is exactly where a worker spawn
 * failure lands.
 */
let launchLog = ''
function collect(deadlineMs: number): Promise<void> {
  const decoder = new TextDecoder()
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, deadlineMs)
    const done = (): void => {
      clearTimeout(timer)
      resolve()
    }
    // A crash before the readiness marker is a third terminal condition,
    // stronger evidence than waiting out the deadline against a dead process.
    void app.exited.then(done)
    for (const stream of [app.stdout, app.stderr]) {
      void (async () => {
        for await (const chunk of stream as ReadableStream<Uint8Array>) {
          launchLog += decoder.decode(chunk, { stream: true })
          if (launchLog.includes('[main] renderer ready')) done()
        }
      })()
    }
  })
}

await collect(60_000)

/**
 * Wait for the app to spawn a sidecar ITSELF. Main arms the catalog and
 * accounts-pool drivers just after first paint, and both go through
 * `sidecarLaunch()` — so their worker-lifecycle records are the only evidence in
 * this file that the packaged app resolved and executed the in-bundle binary.
 * Everything in part A spawns the binary from the test, which proves the binary
 * and nothing about the app.
 *
 * The records land in main's own operational log under the scratch config home,
 * so this reads the app's durable account of what it did rather than a string it
 * happened to print.
 */
const logsDir = join(configHome, 'desktop', 'logs')
function workerRecords(): Array<Record<string, unknown>> {
  if (!existsSync(logsDir)) return []
  return readdirSync(logsDir)
    .filter(name => name.endsWith('.jsonl'))
    .flatMap(name =>
      readFileSync(join(logsDir, name), 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap(line => {
          try {
            return [JSON.parse(line) as Record<string, unknown>]
          } catch {
            return []
          }
        }),
    )
    .filter(record => record.process === 'worker')
}

const workerDeadline = Date.now() + 45_000
let workers = workerRecords()
while (
  Date.now() < workerDeadline &&
  !workers.some(r => r.event === 'process.exited') &&
  app.exitCode === null
) {
  await Bun.sleep(500)
  workers = workerRecords()
}

// Own the process by the exact pid recorded above; never sweep.
app.kill()
// Bounded: a main that ignores SIGTERM must not hang the battery forever.
// Escalate to SIGKILL on timeout so this script can never hang, and keep the
// race's winner: every B1-B5 assertion below reads evidence collected before
// this kill, so nothing else in the file notices a main that swallows SIGTERM.
const exitedAfterTerm = await Promise.race([
  app.exited.then(() => true),
  Bun.sleep(15_000).then(() => false),
])
if (!exitedAfterTerm) {
  app.kill('SIGKILL')
  await app.exited
}

// B0 — the kill above actually worked. Without this, every assertion below
// reads evidence collected before app.kill() and would pass identically
// whether or not the process died, which is exactly the false-success shape
// this smoke exists to catch.
assert(
  exitedAfterTerm,
  'packaged app exited within 15s of SIGTERM',
  `pid ${app.pid} did not exit from SIGTERM; escalated to SIGKILL`,
)

// B1 — the renderer actually loaded and attached its bridge. Main prints this
// only after the window and the renderer bridge are up.
assert(
  launchLog.includes('[main] renderer ready'),
  'packaged app launched and its renderer attached',
  launchLog.slice(-1200),
)

// B2 — production main's own words: the packaged branch ran and the renderer
// came from disk, while a development renderer URL was set in the environment.
// This is the assertion that fails if packaging silently falls back to dev.
assert(
  launchLog.includes('app.isPackaged is true, so the packaged renderer is being loaded from disk'),
  'packaged branch taken with a development renderer URL present',
  launchLog.slice(-1200),
)

// B3 — the development-only diagnostics line must be absent. Main writes it
// under IS_DEV, so its presence would mean the executable name trick failed
// and this whole run proved nothing.
assert(
  !launchLog.includes('[main] desktop diagnostics:'),
  'no development-only startup output',
  launchLog.slice(-600),
)

// B4 — the assertion that makes this a packaged proof for the SIDECAR half. A
// started/exited pair means the app resolved the in-bundle binary, spawned it,
// and it ran to a clean exit. A resolver regression that pointed back at the
// checkout, or at a path that does not exist, cannot produce these.
// A `process.started` record alone proves nothing: main writes it when it asks
// to spawn, and an ENOENT for a wrong path arrives asynchronously afterwards.
// The clean EXIT is the load-bearing half.
assert(
  workers.some(
    r =>
      r.event === 'process.exited' &&
      (r.fields as { expected?: boolean } | undefined)?.expected === true,
  ),
  'the packaged app spawned an in-bundle sidecar worker itself and it exited cleanly',
  `worker records: ${JSON.stringify(workers).slice(0, 600)}`,
)

// B5 — the same fact from the failure side. These lines are what a wrong
// packaged sidecar path actually produces; main writes them unconditionally.
assert(
  !/\[(catalog|accounts)-runner\] refresh failed/.test(launchLog),
  'no worker spawn failure on the packaged path',
  launchLog.slice(-800),
)

if (failed > 0) {
  process.stderr.write(`\n[packaged-launch-smoke] ${failed} assertion(s) failed\n`)
  process.exit(1)
}

console.log(`
[packaged-launch-smoke] all assertions passed

Operator steps for the live acceptance this cannot cover:

  1. Copy the app somewhere with no checkout above it. This removes the
     repository from the app's ancestry entirely, which proves more than
     renaming the checkout would, and it leaves the shared working tree alone
     for the other sessions using it:
       cp -R "app/dist-app/Cat Code.app" /tmp/
  2. Open /tmp/Cat Code.app from Finder (double-click).
  3. Create a session in one project, then a second session in a different
     project. Run a tool in each, approve one permission prompt, and switch
     between the two sessions.
  4. Close the window, reopen the app, and confirm the sessions behave as
     die-with-window v1 specifies.
  5. Quit, then remove the copy:
       rm -rf "/tmp/Cat Code.app"
`)
