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
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, readFileSync, cpSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  describeReadinessFailure,
  terminateChild as terminateSupervisedChild,
  waitForRendererReady,
  type ChildExit,
} from './devLauncher.js'
import { prepareDevElectron } from './prepare-dev-electron.js'
import { prepareAnalyticsFixture, isolatedCaptureEnvironment } from './visualAcceptanceFixture.js'
import { createNativeCaptureRun, nativeCaptureBootstrap, nativeCapturePreservationMessage, preserveNativeCapture, waitForNativeCaptureExit, type NativeCaptureRun } from './nativeCaptureLifetime.js'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')
const electronBin = join(appRoot, 'node_modules', '.bin', 'electron')
const capturePort = process.env.CATCODE_CAPTURE_PORT ?? '5173'
const rendererUrl = `http://localhost:${capturePort}`
const driverOut = join(here, 'visual-acceptance-driver.cjs')

let outDir = resolve(
  process.env.CATCODE_CAPTURE_OUT ?? join(appRoot, '.visual-acceptance'),
)

let scratch: string | null = null
let configHome: string | null = null
let viteProcess: ReturnType<typeof spawn> | null = null
let electronProcess: ReturnType<typeof spawn> | null = null
let nativeRun: NativeCaptureRun | null = null

await main()
process.exit(process.exitCode ?? 0)

async function main(): Promise<void> {
  if (!existsSync(electronBin)) {
    process.stderr.write(`[visual] electron not installed at ${electronBin}\n`)
    process.exitCode = 3
    return
  }

  try {
    // Never the operator's real state. A run that reads ~/.cat-code is a separate,
    // opt-in decision and should read a copy, not the live directory.
    scratch = mkdtempSync(join(tmpdir(), 'catcode-visual-cwd-'))
    scratch = realpathSync(scratch)
    configHome = mkdtempSync(join(tmpdir(), 'catcode-visual-config-'))
    if (process.env.CATCODE_CAPTURE_SCENE === 'analytics-matrix') {
      prepareAnalyticsFixture(configHome, scratch)
    }

    if (process.env.CATCODE_CAPTURE_SCENE === 'usage') {
      const project = join(configHome, 'projects', 'usage-fixture')
      mkdirSync(project, { recursive: true })
      mkdirSync(join(configHome, 'fixture-home'), { recursive: true })
      const rows = []
      const cutoff = new Date()
      for (let day = 0; day < 30; day++) for (let model = 0; model < 4; model++) for (let hour = 0; hour < 24; hour++) {
        const timestamp = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth(), cutoff.getUTCDate() - day, hour))
        if (timestamp > cutoff || hour < 5 || hour > 21 || (day + hour + model) % 5 === 0) continue
        const copies = hour >= 10 && hour <= 17 ? 3 : 1
        for (let n = 0; n < copies; n++) {
          const id = `${day}-${model}-${hour}-${n}`
          rows.push({ type: 'assistant', sessionId: 'fixture', uuid: id, timestamp: timestamp.toISOString(), message: { id, model: ['Claude Sonnet', 'GPT Codex', 'Claude Haiku', 'Other'][model], usage: { input_tokens: (31-day)*(model+1)*120, cache_read_input_tokens: (31-day)*180, cache_creation_input_tokens: 240, output_tokens: (31-day)*30 }, content: [{ type: 'tool_use', id, name: ['Bash','Read','Edit','Search'][model] }] } })
          if ((day + hour + n) % 7 !== 0) rows.push({ type: 'user', sessionId: 'fixture', uuid: `result-${id}`, timestamp: timestamp.toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: (day + hour + model + n) % (model + 9) === 0 }] } })
        }
      }
      writeFileSync(join(project, 'fixture.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'))
    }
    const build = spawnSync('bun', ['run', join(here, 'build-electron.ts')], {
      stdio: 'inherit',
    })
    if (build.status !== 0) {
      process.stderr.write(`[visual] Electron build failed (exit ${build.status ?? 'unknown'})\n`)
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
      ['vite', '--config', join(appRoot, 'renderer', 'vite.config.ts'), '--port', capturePort],
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

    if (process.argv.includes('--prepare-native')) {
      const binary = prepareDevElectron()
      if (!binary) throw new Error('Cat Code Dev bundle is unavailable')
      nativeRun = createNativeCaptureRun(outDir)
      outDir = nativeRun.outDir
      const runDriver = join(outDir, 'driver.cjs')
      copyFileSync(driverOut, runDriver)
      const bootstrap = join(outDir, 'native-bootstrap.cjs')
      const environment = isolatedCaptureEnvironment(configHome, scratch, outDir, rendererUrl)
      environment.CATCODE_CAPTURE_SCENE = process.env.CATCODE_CAPTURE_SCENE ?? ''
      environment.CATCODE_CAPTURE_WIDTHS = process.env.CATCODE_CAPTURE_WIDTHS ?? '1440,1280,900'
      writeFileSync(bootstrap, nativeCaptureBootstrap(nativeRun) + `
for (const key of Object.keys(process.env)) if (/API_KEY|OAUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN/.test(key)) delete process.env[key];
Object.assign(process.env, ${JSON.stringify(environment)});
require(${JSON.stringify(runDriver)});
`)
      writeFileSync(join(outDir, 'native-launch.json'), JSON.stringify({
        bundle_id: 'com.github.Electron', bundlePath: resolve(binary, '../../..'),
        additional_arguments: ['--require', bootstrap, appRoot],
        creates_new_application_instance: true, electron_debugging_port: 9222,
        configHome, scratch, outDir, runId: nativeRun.runId,
      }, null, 2))
      nativeRun.published = true
      process.stdout.write(`[visual] native launch ready: ${join(outDir, 'native-launch.json')}\n`)
      const code = await waitForNativeCaptureExit(nativeRun, 12 * 60_000)
      const result = JSON.parse(readFileSync(join(outDir, 'result.json'), 'utf8'))
      const diagnostics = join(configHome, 'desktop', 'logs')
      if (existsSync(diagnostics)) cpSync(diagnostics, join(outDir, 'diagnostics'), { recursive: true })
      process.stdout.write(`[visual] native result: ${JSON.stringify(result)}\n`)
      process.exitCode = result.ok && code === 0 ? 0 : 1
      return
    }

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
        ...(process.env.CATCODE_CAPTURE_SCENE === 'usage' ? {
          CATCODE_USAGE_DASHBOARD: '1', HOME: join(configHome, 'fixture-home'),
          ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', OPENAI_API_KEY: '',
        } : {}),
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
  if (preserveNativeCapture(nativeRun)) {
    process.stderr.write(`[visual] ${nativeCapturePreservationMessage(nativeRun!, { scratch, configHome, vitePid: viteProcess?.pid })}\n`)
    return
  }
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
