/**
 * Build the production renderer, main, and preload, then launch the actual
 * desktop main process in its production-path hardening mode. Single entry
 * point for CI/verify:
 *
 *   bun run app/scripts/run-hardening-smoke.ts
 *
 * Exits non-zero if the build fails, Electron cannot launch, or any hardening
 * assertion fails.
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { prepareDevElectron } from './prepare-dev-electron.js'
import { isolatedCaptureEnvironment } from './visualAcceptanceFixture.js'
import { createNativeCaptureRun, nativeCaptureBootstrap, nativeCapturePreservationMessage, preserveNativeCapture, waitForNativeCaptureExit, type NativeCaptureRun } from './nativeCaptureLifetime.js'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')
const electronBin = join(appRoot, 'node_modules', '.bin', 'electron')
const configHome = mkdtempSync(join(tmpdir(), 'catcode-hardening-config-'))
const harnessOut = join(here, 'hardening-smoke.cjs')
let nativeRun: NativeCaptureRun | null = null

async function main(): Promise<void> {
  if (!existsSync(electronBin)) {
    process.stderr.write(
      `[run-hardening-smoke] electron not installed at ${electronBin}; run 'bun install' in app/\n`,
    )
    process.exitCode = 3
    return
  }

  // 1. Build the real renderer consumed by production main.
  const renderer = spawnSync('bun', ['run', 'renderer:build'], {
    stdio: 'inherit',
    cwd: appRoot,
  })
  if (renderer.status !== 0) {
    process.stderr.write('[run-hardening-smoke] renderer build failed\n')
    process.exitCode = renderer.status ?? 1
    return
  }

  // 2. Build the real main and preload bundles.
  const build = spawnSync('bun', ['run', join(here, 'build-electron.ts')], {
    stdio: 'inherit',
  })
  if (build.status !== 0) {
    process.stderr.write('[run-hardening-smoke] Electron build failed\n')
    process.exitCode = build.status ?? 1
    return
  }

  // 3. Bundle the external main-process preload harness. Production main does not
  // import it; NODE_OPTIONS loads it before the real main bundle evaluates.
  const harness = await Bun.build({
    entrypoints: [join(here, 'hardening-smoke.ts')],
    outdir: here,
    target: 'node',
    format: 'cjs',
    external: ['electron'],
    naming: '[name].cjs',
  })
  if (!harness.success) {
    for (const message of harness.logs) console.error(message)
    process.stderr.write('[run-hardening-smoke] harness bundle failed\n')
    process.exitCode = 1
    return
  }

  // 4. Launch app/package.json -> app/main/main.js, not a surrogate BrowserWindow.
  // Electron's own --require hook runs after its main-process API is initialized.
  if (process.argv.includes('--prepare-native')) {
    const binary = prepareDevElectron()
    if (!binary) throw new Error('Cat Code Dev bundle is unavailable')
    nativeRun = createNativeCaptureRun(process.env.CATCODE_HARDENING_OUT ?? join(tmpdir(), 'catcode-hardening-evidence'))
    const outDir = nativeRun.outDir
    const runHarness = join(outDir, 'driver.cjs')
    copyFileSync(harnessOut, runHarness)
    mkdirSync(join(configHome, 'fixture-home'), { recursive: true })
    mkdirSync(join(outDir, 'electron-profile'), { recursive: true })
    const bootstrap = join(outDir, 'native-bootstrap.cjs')
    writeFileSync(bootstrap, nativeCaptureBootstrap(nativeRun) + `
  for (const key of Object.keys(process.env)) if (/API_KEY|OAUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN/.test(key)) delete process.env[key];
  Object.assign(process.env, ${JSON.stringify(isolatedCaptureEnvironment(configHome, configHome, outDir))});
  delete process.env.CATCODE_RENDERER_URL;
  app.setPath('userData', ${JSON.stringify(join(outDir, 'electron-profile'))});
  require(${JSON.stringify(runHarness)});
  `)
    writeFileSync(join(outDir, 'native-launch.json'), JSON.stringify({
      bundle_id: 'com.github.Electron', bundlePath: join(binary, '../../..'),
      additional_arguments: ['--require', bootstrap, appRoot],
      creates_new_application_instance: true, outDir, configHome, runId: nativeRun.runId,
    }, null, 2))
    nativeRun.published = true
    process.stdout.write(`[hardening] native launch ready: ${join(outDir, 'native-launch.json')}\n`)
    const code = await waitForNativeCaptureExit(nativeRun, 10 * 60_000)
    const log = readFileSync(join(outDir, 'electron.log'), 'utf8')
    process.stdout.write(log)
    const passed = log.includes('[hardening-smoke] renderer document + main-process policy passed') &&
      !log.includes('[hardening-smoke] FAIL:') &&
      code === 0
    writeFileSync(join(outDir, 'result.json'), JSON.stringify({ ok: passed, runId: nativeRun.runId }))
    process.exitCode = passed ? 0 : 1
    return
  }
  const smoke = spawnSync(electronBin, ['--require', harnessOut, appRoot], {
    encoding: 'utf8',
    cwd: appRoot,
    env: { ...process.env, CLAUDE_CONFIG_DIR: configHome },
    timeout: 20_000,
  })
  if (smoke.stdout) process.stdout.write(smoke.stdout)
  if (smoke.stderr) process.stderr.write(smoke.stderr)
  if (
    smoke.error !== undefined ||
    smoke.status !== 0 ||
    !smoke.stdout?.includes('[hardening-smoke] renderer document + main-process policy passed')
  ) {
    process.stderr.write('[run-hardening-smoke] renderer/main hardening assertions did not pass\n')
    process.exitCode = 1
    return
  }
}

try {
  await main()
} catch (error) {
  process.stderr.write(`[run-hardening-smoke] failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  rmSync(harnessOut, { force: true })
  if (preserveNativeCapture(nativeRun)) {
    process.stderr.write(`[run-hardening-smoke] ${nativeCapturePreservationMessage(nativeRun!, { configHome })}\n`)
  } else {
    rmSync(configHome, { recursive: true, force: true })
  }
}
process.exit(process.exitCode ?? 0)
