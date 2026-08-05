import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  describeReadinessFailure,
  waitForRendererReady,
  type ChildExit,
} from './devLauncher.js'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')
const electronBin = join(appRoot, 'node_modules', '.bin', 'electron')
const rendererUrl = 'http://localhost:5173'

const driverOut = join(here, 'harness-demo-driver.cjs')
let scratch: string | null = null
let configHome: string | null = null
let viteProcess: ReturnType<typeof spawn> | null = null

await main()
process.exit(process.exitCode ?? 0)

async function main(): Promise<void> {
  if (!existsSync(electronBin)) {
    process.stderr.write(`[harness-demo] electron not installed at ${electronBin}\n`)
    process.exitCode = 3
    return
  }

  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'catcode-harness-cwd-')))
  configHome = mkdtempSync(join(tmpdir(), 'catcode-harness-config-'))

  try {
    const build = spawnSync('bun', ['run', join(here, 'build-electron.ts')], {
      stdio: 'inherit',
    })
    if (build.status !== 0) {
      process.exitCode = build.status ?? 1
      return
    }

    const driver = await Bun.build({
      entrypoints: [join(here, 'harness-demo-driver.ts')],
      outdir: here,
      target: 'node',
      format: 'cjs',
      external: ['electron'],
      naming: 'harness-demo-driver.cjs',
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
    viteProcess.stdout?.on('data', chunk => process.stdout.write(chunk))
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
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      timeoutMs: 15_000,
      pollMs: 150,
    })
    if (!readiness.ok) throw new Error(describeReadinessFailure(readiness, rendererUrl))

    let sawReady = false
    const electron = spawn(electronBin, ['--require', driverOut, appRoot], {
      cwd: appRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CATCODE_RENDERER_URL: rendererUrl,
        CATCODE_TEST_CWD_ALLOWLIST: scratch,
        CATCODE_INITIAL_CWD: scratch,
        CATCODE_DEBUG_STATE: '1',
        CATCODE_HARNESS_DEMO_CWD: scratch,
        CLAUDE_CONFIG_DIR: configHome,
      },
    })
    electron.stdout?.on('data', chunk => {
      const text = String(chunk)
      if (text.includes('[main] renderer ready')) sawReady = true
      process.stdout.write(chunk)
    })
    electron.stderr?.on('data', chunk => process.stderr.write(chunk))
    const status = await waitForExit(electron, 45_000)
    if (!sawReady) {
      process.stderr.write('[harness-demo] readiness line was not observed\n')
      process.exitCode = 1
      return
    }
    if (status !== 0) {
      process.exitCode = status ?? 1
      return
    }
    process.exitCode = 0
  } catch (error) {
    process.stderr.write(
      `[harness-demo] failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    )
    process.exitCode = 1
  } finally {
    await cleanup()
  }
}

async function cleanup(): Promise<void> {
  const vite = viteProcess
  viteProcess = null
  if (vite) {
    await terminateChild(vite)
  }
  rmSync(driverOut, { force: true })
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  if (configHome) rmSync(configHome, { recursive: true, force: true })
}

function terminateChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
      }
    }, 2_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill('SIGTERM')
  })
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

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Electron demo timed out'))
    }, timeoutMs)
    child.on('exit', code => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}
