/**
 * Stage 1 of the headless visual-acceptance harness
 * (`docs/plans/2026-08-22-headless-visual-acceptance-harness.md`).
 *
 * Boots the real desktop app against an isolated config dir and scratch cwd, then
 * photographs the live renderer. Nothing is ever shown on screen and nothing takes
 * focus, so this is safe to run while the operator is working.
 *
 * Deliberately modelled on `harness-demo.ts` rather than replacing it: same Vite +
 * Electron boot, same `devLauncher` readiness and teardown, same `--require`
 * driver injection. The difference is what the driver does once it is in.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  describeReadinessFailure,
  terminateChild as terminateSupervisedChild,
  waitForRendererReady,
  type ChildExit,
} from './devLauncher.js'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')
const electronBin = join(appRoot, 'node_modules', '.bin', 'electron')
const rendererUrl = 'http://localhost:5173'
const driverOut = join(here, 'visual-acceptance-driver.cjs')

const outDir = resolve(
  process.env.CATCODE_CAPTURE_OUT ?? join(appRoot, '.visual-acceptance'),
)

let scratch: string | null = null
let configHome: string | null = null
let viteProcess: ReturnType<typeof spawn> | null = null
let electronProcess: ReturnType<typeof spawn> | null = null

await main()
process.exit(process.exitCode ?? 0)

async function main(): Promise<void> {
  if (!existsSync(electronBin)) {
    process.stderr.write(`[visual] electron not installed at ${electronBin}\n`)
    process.exitCode = 3
    return
  }

  // Never the operator's real state. A run that reads ~/.cat-code is a separate,
  // opt-in decision and should read a copy, not the live directory.
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'catcode-visual-cwd-')))
  configHome = mkdtempSync(join(tmpdir(), 'catcode-visual-config-'))

  try {
    const build = spawnSync('bun', ['run', join(here, 'build-electron.ts')], {
      stdio: 'inherit',
    })
    if (build.status !== 0) {
      process.exitCode = build.status ?? 1
      return
    }

    const driver = await Bun.build({
      entrypoints: [join(here, 'visual-acceptance-driver.ts')],
      outdir: here,
      target: 'node',
      format: 'cjs',
      external: ['electron'],
      naming: 'visual-acceptance-driver.cjs',
    })
    if (!driver.success) {
      for (const message of driver.logs) console.error(message)
      process.exitCode = 1
      return
    }

    viteProcess = spawn(
      'bunx',
      ['vite', '--config', join(appRoot, 'renderer', 'vite.config.ts')],
      { cwd: appRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    viteProcess.stderr?.on('data', chunk => process.stderr.write(chunk))

    const readiness = await waitForRendererReady({
      probe: async () => {
        try {
          await fetch(rendererUrl)
          return true
        } catch {
          return false
        }
      },
      childExit: viteExit,
      now: () => Date.now(),
      sleep: ms => new Promise(r => setTimeout(r, ms)),
      timeoutMs: 15_000,
      pollMs: 150,
    })
    if (!readiness.ok) throw new Error(describeReadinessFailure(readiness, rendererUrl))

    let captured = 0
    const electron = spawn(electronBin, ['--require', driverOut, appRoot], {
      cwd: appRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CATCODE_RENDERER_URL: rendererUrl,
        CATCODE_TEST_CWD_ALLOWLIST: scratch,
        CATCODE_HEADLESS_CAPTURE: '1',
        CATCODE_CAPTURE_OUT: outDir,
        CLAUDE_CONFIG_DIR: configHome,
      },
    })
    electronProcess = electron
    electron.stdout?.on('data', chunk => {
      const text = String(chunk)
      const done = /\[capture\] done (\d+)/.exec(text)
      if (done) captured = Number(done[1])
      if (text.startsWith('[capture]')) process.stdout.write(chunk)
    })
    electron.stderr?.on('data', chunk => process.stderr.write(chunk))

    const status = await waitForExit(electron, 90_000)
    if (status !== 0) {
      process.stderr.write(`[visual] electron exited ${status}\n`)
      process.exitCode = status ?? 1
      return
    }
    if (captured < 1) {
      process.stderr.write('[visual] no captures were produced\n')
      process.exitCode = 1
      return
    }
    process.stdout.write(`[visual] ${captured} capture(s) in ${outDir}\n`)
    process.exitCode = 0
  } catch (error) {
    process.stderr.write(
      `[visual] failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    )
    process.exitCode = 1
  } finally {
    await cleanup()
  }
}

/**
 * Our Vite child's exit, or null while it runs. `strictPort` means a leftover
 * server from an earlier run makes OUR child exit while the stale one keeps
 * answering the probe, so readiness has to follow the child we own.
 */
function viteExit(): ChildExit | null {
  const vite = viteProcess
  if (!vite) return null
  if (vite.exitCode === null && vite.signalCode === null) return null
  return { code: vite.exitCode, signal: vite.signalCode }
}

async function terminateChild(child: ReturnType<typeof spawn>): Promise<void> {
  await terminateSupervisedChild({
    kill: signal => child.kill(signal),
    hasExited: () => child.exitCode !== null || child.signalCode !== null,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => Date.now(),
    graceMs: 2_000,
    pollMs: 50,
  })
}

function waitForExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<number | null> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    child.once('exit', code => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

async function cleanup(): Promise<void> {
  const vite = viteProcess
  const electron = electronProcess
  viteProcess = null
  electronProcess = null
  await Promise.all([
    ...(vite ? [terminateChild(vite)] : []),
    ...(electron ? [terminateChild(electron)] : []),
  ])
  for (const dir of [scratch, configHome]) {
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
}
