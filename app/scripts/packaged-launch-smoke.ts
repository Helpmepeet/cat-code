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
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')
const bundle = join(appRoot, 'dist-app', 'Cat Code.app')
const executable = join(bundle, 'Contents', 'MacOS', 'Cat Code')
const sidecar = join(bundle, 'Contents', 'Resources', 'sidecar', 'cat-code-sidecar')

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

// Scratch homes so nothing here can reach the operator's ~/.cat-code.
const configHome = mkdtempSync(join(tmpdir(), 'catcode-packaged-config-'))
const workDir = mkdtempSync(join(tmpdir(), 'catcode-packaged-cwd-'))

console.log('A. compiled sidecar, no bun on PATH, outside the checkout')

// A1 — the engine graph really is inside the binary. Without socket env the
// sidecar hits its own startup guard, and the stack frame names the embedded
// filesystem rather than a .ts file in the repository.
const guard = spawnSync(sidecar, ['session'], {
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
const markerDir = mkdtempSync(join(tmpdir(), 'catcode-packaged-marker-'))
const cleanup = spawnSync(sidecar, ['debug-cleanup'], {
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
const catalogHome = mkdtempSync(join(tmpdir(), 'catcode-packaged-catalog-'))
const catalog = spawnSync(sidecar, ['catalog', '--bare'], {
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
rmSync(catalogHome, { recursive: true, force: true })

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
 */
function collect(deadlineMs: number): Promise<string> {
  let text = ''
  const decoder = new TextDecoder()
  return new Promise<string>(resolve => {
    const timer = setTimeout(() => resolve(text), deadlineMs)
    const done = (): void => {
      clearTimeout(timer)
      resolve(text)
    }
    for (const stream of [app.stdout, app.stderr]) {
      void (async () => {
        for await (const chunk of stream as ReadableStream<Uint8Array>) {
          text += decoder.decode(chunk, { stream: true })
          if (text.includes('[main] renderer ready')) return done()
        }
      })()
    }
  })
}

const launchText = await collect(60_000)
// Own the process by the exact pid recorded above; never sweep.
app.kill()
await app.exited

// B1 — the renderer actually loaded and attached its bridge. Main prints this
// only after the window and the renderer bridge are up.
assert(
  launchText.includes('[main] renderer ready'),
  'packaged app launched and its renderer attached',
  launchText.slice(-1200),
)

// B2 — production main's own words: the packaged branch ran and the renderer
// came from disk, while a development renderer URL was set in the environment.
// This is the assertion that fails if packaging silently falls back to dev.
assert(
  launchText.includes('app.isPackaged is true, so the packaged renderer is being loaded from disk'),
  'packaged branch taken with a development renderer URL present',
  launchText.slice(-1200),
)

// B3 — the development-only diagnostics line must be absent. Main writes it
// under IS_DEV, so its presence would mean the executable name trick failed
// and this whole run proved nothing.
assert(
  !launchText.includes('[main] desktop diagnostics:'),
  'no development-only startup output',
  launchText.slice(-600),
)

rmSync(configHome, { recursive: true, force: true })
rmSync(workDir, { recursive: true, force: true })
rmSync(markerDir, { recursive: true, force: true })

if (failed > 0) {
  process.stderr.write(`\n[packaged-launch-smoke] ${failed} assertion(s) failed\n`)
  process.exit(1)
}

console.log(`
[packaged-launch-smoke] all assertions passed

Operator steps for the live acceptance this cannot cover:

  1. Move the checkout aside so nothing can fall back to it:
       cd /Users/pt && mv cat-code cat-code.moved
  2. Open ~/cat-code.moved/app/dist-app/Cat Code.app from Finder (double-click).
  3. Create a session in one project, then a second session in a different
     project. Run a tool in each, approve one permission prompt, and switch
     between the two sessions.
  4. Close the window, reopen the app, and confirm the sessions behave as
     die-with-window v1 specifies.
  5. Quit, then restore the checkout:
       cd /Users/pt && mv cat-code.moved cat-code
`)
