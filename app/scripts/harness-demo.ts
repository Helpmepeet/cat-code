import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')
const electronBin = join(appRoot, 'node_modules', '.bin', 'electron')
const rendererUrl = 'http://localhost:5173'

if (!existsSync(electronBin)) {
  process.stderr.write(`[harness-demo] electron not installed at ${electronBin}\n`)
  process.exit(3)
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'catcode-harness-cwd-')))
const configHome = mkdtempSync(join(tmpdir(), 'catcode-harness-config-'))
const driverOut = join(here, 'harness-demo-driver.cjs')

try {
  const build = spawnSync('bun', ['run', join(here, 'build-electron.ts')], {
    stdio: 'inherit',
  })
  if (build.status !== 0) process.exit(build.status ?? 1)

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
    process.exit(1)
  }

  const vite = spawn(
    'bunx',
    ['vite', '--config', join(appRoot, 'renderer', 'vite.config.ts')],
    { cwd: appRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  vite.stdout?.on('data', chunk => process.stdout.write(chunk))
  vite.stderr?.on('data', chunk => process.stderr.write(chunk))
  await waitForServer(rendererUrl, 15_000)

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
  vite.kill()
  if (!sawReady) {
    process.stderr.write('[harness-demo] readiness line was not observed\n')
    process.exit(1)
  }
  if (status !== 0) process.exit(status ?? 1)
  process.exit(0)
} finally {
  rmSync(driverOut, { force: true })
  rmSync(scratch, { recursive: true, force: true })
  rmSync(configHome, { recursive: true, force: true })
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fetch(url)
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 150))
    }
  }
  throw new Error(`Vite did not come up at ${url}`)
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
