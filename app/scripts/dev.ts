/**
 * Dev launcher: build main+preload, start the Vite renderer dev server, then
 * launch Electron pointed at it. Ctrl-C tears all three down.
 *
 * `bun run dev` (from app/) is the day-to-day entrypoint.
 */

import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { prepareDevElectron } from './prepare-dev-electron.js'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')

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
const vite = spawn(
  'bunx',
  ['vite', '--config', join(appRoot, 'renderer', 'vite.config.ts')],
  { stdio: 'inherit', cwd: appRoot },
)

// 3. Wait for Vite to be reachable, then launch Electron.
const RENDERER_URL = 'http://localhost:5173'
await waitForServer(RENDERER_URL, 15_000)

const electron = spawn(electronBin, ['.'], {
  stdio: 'inherit',
  cwd: appRoot,
  env: { ...process.env, CATCODE_RENDERER_URL: RENDERER_URL },
})

const shutdown = () => {
  electron.kill()
  vite.kill()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
electron.on('exit', shutdown)

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now()
  for (;;) {
    try {
      await fetch(url)
      return
    } catch {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Vite did not come up at ${url}`)
      }
      await new Promise(r => setTimeout(r, 200))
    }
  }
}
