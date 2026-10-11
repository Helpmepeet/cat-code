/** Build-only by default. --run launches an isolated, never-shown real main. */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanupInterruptedRun, OwnedProcessGroupLifecycle } from './streaming-benchmark-cleanup.js'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const run = process.argv.includes('--run')
const baseline = process.argv.includes('--baseline')
const mode = value('--mode') ?? 'packaged'
const scenario = value('--scenario') ?? 'first'
const out = value('--out')
if (!['dev', 'packaged'].includes(mode) || !['first', 'repeat', 'quit', 'superseded'].includes(scenario)) throw new Error('invalid mode/scenario')
if (run && !out) throw new Error('--run requires --out for retained evidence')
// Chromium canonicalizes macOS /var file URLs to /private/var. Match that
// identity before applying the fixture's own file-request containment check.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'catcode-startup-recovery-')))
const groups = new OwnedProcessGroupLifecycle()
let server: ReturnType<typeof Bun.serve> | null = null
let keepScratch = false
for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
  process.once(signal, () => {
    void cleanupInterruptedRun({
      processGroupId: groups.activeProcessGroupId,
      removeScratch: () => { server?.stop(true); rmSync(scratch, { recursive: true, force: true }) },
      exit: code => process.exit(code), exitCode,
    }).catch(error => { process.stderr.write(`${String(error)}\n`); process.exit(exitCode) })
  })
}
try {
  mkdirSync(join(scratch, 'config'))
  mkdirSync(join(scratch, 'main'))
  mkdirSync(join(scratch, 'preload'))
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'catcode-startup-recovery', type: 'module', main: 'main/main.js' }))
  const baselineSources = new Map<string, string>()
  if (baseline) {
    // The old main imports a CLI helper removed by the editor repair. Restore
    // its matching owner in this bundle so the negative control reaches the
    // native load boundary rather than failing before Electron starts.
    for (const path of ['main/main.ts', 'main/mainDecisions.ts']) {
      const before = spawnSync('git', ['show', `14dff2006ad1a16386c5000861d77cdada0302f2:app/${path}`], {
        cwd: appRoot, encoding: 'utf8',
      })
      if (before.status !== 0) throw new Error(`cannot load baseline ${path}: ${before.stderr}`)
      baselineSources.set(join(appRoot, path), before.stdout)
    }
  }
  await bundle(join(appRoot, 'main/main.ts'), join(scratch, 'main'), 'main.js', 'esm', baselineSources)
  for (const dev of [false, true]) {
    await bundle(join(appRoot, 'preload/preload.ts'), join(scratch, 'preload'), dev ? 'preload.dev.cjs' : 'preload.cjs', 'cjs', undefined,
      { __CATCODE_DEV_HARNESS__: JSON.stringify(dev) })
  }
  await bundle(join(appRoot, 'scripts/renderer-startup-recovery-harness.ts'), scratch, 'recovery-harness.cjs', 'cjs')
  const rendererDir = join(scratch, 'renderer/dist')
  const build = spawnSync('bunx', ['vite', 'build', '--config', join(appRoot, 'renderer/vite.config.ts'), '--outDir', rendererDir], {
    cwd: appRoot, encoding: 'utf8',
  })
  if (build.status !== 0) throw new Error(`renderer fixture build failed: ${build.stdout}\n${build.stderr}`)
  if (!run) {
    process.stdout.write(`${JSON.stringify({ prepared: true, launched: false, mode, scenario, baseline })}\n`)
  } else {
    const electron = join(appRoot, 'node_modules/.bin/electron')
    if (!existsSync(electron)) throw new Error('Electron is not installed')
    if (mode === 'dev') {
      server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
        const pathname = decodeURIComponent(new URL(request.url).pathname)
        const target = resolve(rendererDir, `.${pathname === '/' ? '/index.html' : pathname}`)
        if (!target.startsWith(`${rendererDir}/`)) return new Response('refused', { status: 403 })
        return new Response(Bun.file(target))
      } })
    }
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '', LANG: process.env.LANG ?? 'C.UTF-8',
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      CLAUDE_CONFIG_DIR: join(scratch, 'config'), CATCODE_HEADLESS_CAPTURE: '1',
      CATCODE_RECOVERY_FIXTURE_ROOT: scratch, CATCODE_RECOVERY_MODE: mode, CATCODE_RECOVERY_SCENARIO: scenario,
      CATCODE_USAGE_DASHBOARD: '0', ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', OPENAI_API_KEY: '',
      ...(server ? { CATCODE_RENDERER_URL: `http://127.0.0.1:${server.port}/` } : {}),
    }
    const child = spawn(electron, ['--require', join(scratch, 'recovery-harness.cjs'), scratch], {
      cwd: scratch, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (!child.pid) throw new Error('Electron returned no owned pid')
    groups.begin(child.pid)
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-65_536) })
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-65_536) })
    const exit = await new Promise<{ code: number | null; error?: string }>(resolvePromise => {
      const timer = setTimeout(() => resolvePromise({ code: null, error: 'Electron timeout' }), 12_000)
      child.once('error', error => { clearTimeout(timer); resolvePromise({ code: null, error: error.message }) })
      child.once('exit', code => { clearTimeout(timer); resolvePromise({ code }) })
    })
    await groups.reapActive(exit.error ? 0 : 1_000)
    const resultPath = join(scratch, 'fixture-result.json')
    const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : null
    const logPaths = Array.from(new Bun.Glob('**/operational-*.jsonl').scanSync(join(scratch, 'config')))
    const logs = logPaths.flatMap(path => readFileSync(join(scratch, 'config', path), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)))
    const started = logs.filter(row => row.event === 'renderer.recovery.started').length
    const succeeded = logs.filter(row => row.event === 'renderer.recovery.succeeded').length
    const exhausted = logs.filter(row => row.event === 'renderer.recovery.exhausted').length
    const failures = result?.observations.filter((row: { kind: string; errno?: number }) => row.kind === 'promise-rejected') ?? []
    const checks = {
      cleanExit: exit.code === 0 && !exit.error,
      neverShown: result?.shown === 0,
      actualFirstFailure: failures.some((row: { attempt: number; errno: number }) => row.attempt === 1 && row.errno !== -3 && row.errno < 0),
      expectedAttempts: result?.attempts === (scenario === 'repeat' ? 4 : scenario === 'quit' ? 1 : 2),
      // Rapid same-reason attempts may be deduplicated by the durable sink;
      // native document invocations above independently establish all retries.
      expectedRecovery: scenario === 'repeat' ? started >= 1 && started <= 3 : started === (scenario === 'quit' ? 0 : 1),
      expectedReadiness: scenario === 'repeat' || scenario === 'quit' ? result?.ready === 0 : result?.ready >= 1 && succeeded === 1,
      expectedFatal: scenario === 'repeat' ? result?.dialogs === 1 && exhausted === 1 : result?.dialogs === 0 && exhausted === 0,
      shutdownRecorded: logs.some(row => row.event === 'app.shutdown.completed'),
    }
    const evidence = { baseline, mode, scenario, ownedPid: child.pid, processGroupReaped: true, checks, result, started, succeeded, exhausted, exit, stdout, stderr, logs }
    const durableOut = resolve(out!)
    mkdirSync(dirname(durableOut), { recursive: true })
    writeFileSync(durableOut, JSON.stringify(evidence, null, 2))
    process.stdout.write(`${JSON.stringify({ mode, scenario, baseline, checks, evidence: durableOut })}\n`)
    if (Object.values(checks).some(pass => !pass)) process.exitCode = 1
  }
} finally {
  server?.stop(true)
  try { await groups.reapActive(0) } catch (error) { keepScratch = true; throw error }
  if (!keepScratch) rmSync(scratch, { recursive: true, force: true })
}

function value(flag: string) { const index = process.argv.indexOf(flag); return index < 0 ? undefined : process.argv[index + 1] }
async function bundle(entry: string, outdir: string, name: string, format: 'esm' | 'cjs', sources?: ReadonlyMap<string, string>, define?: Record<string, string>) {
  const result = await Bun.build({ entrypoints: [entry], outdir, naming: name, format, target: 'node', external: ['electron'], define,
    plugins: sources?.size ? [{ name: 'recorded-main-baseline', setup(build) {
      build.onLoad({ filter: /\/main\/main(?:Decisions)?\.ts$/ }, args => {
        const source = sources.get(args.path)
        return source === undefined ? undefined : { contents: source, loader: 'ts', resolveDir: dirname(args.path) }
      })
    } }] : [],
  })
  if (!result.success) throw new Error(result.logs.map(item => item.message).join('\n'))
}
