/** Builds an isolated Electron benchmark; --run is intentionally required to launch it. */
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { manifest } from '../../docs/reports/2026-09-12-live-streaming-measurements/fixture.js'

const run = process.argv.includes('--run')
const requestedWorkload = valueAfter('--workload')
const requestedPolicy = valueAfter('--policy')
const requestedOut = valueAfter('--out')
if (run && !requestedOut) throw new Error('--run requires --out so raw samples survive scratch cleanup')
const workloads = requestedWorkload ? manifest.workloads.filter(item => item.id === requestedWorkload) : manifest.workloads
const policies = requestedPolicy ? manifest.policies.filter(item => item === requestedPolicy) : manifest.policies
if (workloads.length === 0 || policies.length === 0) throw new Error('unknown workload or policy')

const appRoot = resolve(import.meta.dir, '..')
const sourcePaths = [
  'main/liveFrameBatcher.ts', 'main/attachmentGate.ts', 'main/deliveryTraceSink.ts', 'shared/deliveryTrace.ts',
  'shared/ipcChannels.ts', 'renderer/src/App.tsx', 'renderer/src/rawMessageLog.ts', 'preload/preload.ts',
  'scripts/streaming-benchmark.ts', 'scripts/streaming-benchmark-main.ts', 'scripts/streaming-benchmark-observer.ts',
  'scripts/streaming-benchmark.vite.config.ts', 'package.json',
  '../docs/reports/2026-09-12-live-streaming-measurements/fixture.ts',
] as const
const hashesBefore = sourceHashes()
const scratch = mkdtempSync(join(tmpdir(), 'catcode-streaming-benchmark-'))
const rendererOut = join(scratch, 'renderer')
const bundleOut = join(scratch, 'bundle')
mkdirSync(bundleOut)

try {
  await bundle(resolve(appRoot, 'preload/preload.ts'), bundleOut, 'preload.cjs', 'cjs', { __CATCODE_DEV_HARNESS__: 'false' })
  await bundle(resolve(appRoot, 'scripts/streaming-benchmark-main.ts'), bundleOut, 'main.js', 'esm')
  const build = spawnSync('bunx', ['vite', 'build', '--config', resolve(appRoot, 'scripts/streaming-benchmark.vite.config.ts')], {
    cwd: appRoot, stdio: 'inherit', env: allowlistedEnv({ CATCODE_STREAMING_BENCHMARK_RENDERER_OUT: rendererOut }),
  })
  if (build.status !== 0) throw new Error(`renderer build failed (${build.status})`)
  const hashesAfter = sourceHashes()
  if (JSON.stringify(hashesBefore) !== JSON.stringify(hashesAfter)) throw new Error('benchmark inputs changed during build; retry from a stable tree')

  if (!run) {
    process.stdout.write(`${JSON.stringify({ prepared: true, launched: false, workloads: workloads.map(item => item.id), policies, sourceHashes: hashesAfter })}\n`)
  } else {
    const durableOut = resolve(requestedOut!)
    mkdirSync(durableOut, { recursive: true })
    const electron = resolve(appRoot, 'node_modules/.bin/electron')
    for (let repetition = 0; repetition < manifest.repetitions; repetition++) {
      const rotated = [...policies.slice(repetition % policies.length), ...policies.slice(0, repetition % policies.length)]
      for (const workload of workloads) for (const policy of rotated) {
        const sampleName = `sample-${repetition}-${workload.id}-${policy}`
        const sample = join(scratch, sampleName)
        mkdirSync(sample)
        const outcome = await runOwnedElectron(electron, join(bundleOut, 'main.js'), sample, allowlistedEnv({
          CLAUDE_CONFIG_DIR: join(sample, 'config'), CATCODE_STREAMING_BENCHMARK_RUN_DIR: sample,
          CATCODE_STREAMING_BENCHMARK_RENDERER_OUT: rendererOut, CATCODE_STREAMING_BENCHMARK_PRELOAD: join(bundleOut, 'preload.cjs'),
          CATCODE_STREAMING_BENCHMARK_WORKLOAD: workload.id, CATCODE_STREAMING_BENCHMARK_POLICY: policy,
        }), manifest.warmupMs + manifest.durationMs + 30_000)
        if (!outcome.ok) throw new Error(`sample failed: ${outcome.error}`)
        const result = JSON.parse(readFileSync(join(sample, 'result.json'), 'utf8'))
        const durable = { repetition, ...result, sourceHashes: hashesAfter }
        writeFileSync(join(durableOut, `${sampleName}.json`), `${JSON.stringify(durable)}\n`, { flag: 'wx' })
        await verifyOwnedPidsExited(result.ownedPids)
        process.stdout.write(`${JSON.stringify(durable)}\n`)
      }
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

async function bundle(entry: string, outdir: string, name: string, format: 'esm' | 'cjs', define?: Record<string, string>) {
  const result = await Bun.build({ entrypoints: [entry], outdir, target: 'node', format, external: ['electron'], naming: name, define })
  if (!result.success) throw new Error(result.logs.map(item => item.message).join('\n'))
}
function sourceHashes() { return Object.fromEntries(sourcePaths.map(path => [path, sha256(readFileSync(resolve(appRoot, path))) ])) }
function valueAfter(flag: string) { const index = process.argv.indexOf(flag); return index < 0 ? undefined : process.argv[index + 1] }
function sha256(value: Uint8Array) { return createHash('sha256').update(value).digest('hex') }
function allowlistedEnv(extra: Record<string, string>) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', LANG: process.env.LANG ?? 'C.UTF-8' }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  return { ...env, ...extra }
}

async function runOwnedElectron(executable: string, main: string, cwd: string, env: Record<string, string>, timeoutMs: number): Promise<{ ok: boolean; error?: string }> {
  const child = spawn(executable, [main], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  const ownedRootPid = child.pid
  if (!ownedRootPid) return { ok: false, error: 'Electron did not return a pid' }
  let stderr = ''
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8_192) })
  return await new Promise(resolvePromise => {
    let settled = false
    const finish = (value: { ok: boolean; error?: string }) => { if (!settled) { settled = true; clearTimeout(timer); resolvePromise(value) } }
    const timer = setTimeout(() => {
      // The fresh detached process group belongs solely to this sample. Signal
      // that exact group, including its Electron helpers, without discovery or
      // a name-based sweep.
      try { process.kill(-ownedRootPid, 'SIGTERM') } catch {}
      setTimeout(() => {
        try { process.kill(-ownedRootPid, 'SIGKILL') } catch {}
        finish({ ok: false, error: `Electron process group ${ownedRootPid} timed out` })
      }, 2_000)
    }, timeoutMs)
    child.once('error', error => finish({ ok: false, error: error.message }))
    child.once('exit', (code, signal) => finish(code === 0 ? { ok: true } : { ok: false, error: `pid ${ownedRootPid} exited code=${code} signal=${signal}: ${stderr}` }))
  })
}

async function verifyOwnedPidsExited(value: unknown): Promise<void> {
  if (!Array.isArray(value) || value.some(pid => !Number.isSafeInteger(pid) || pid < 1)) throw new Error('fixture did not report exact owned PIDs')
  const pids = value as number[]
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (pids.every(pid => !pidAlive(pid))) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25))
  }
  const live = pids.filter(pidAlive)
  for (const pid of live) { try { process.kill(pid, 'SIGTERM') } catch {} }
  throw new Error(`owned Electron processes remained after exit: ${live.join(',')}`)
}
function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true } catch { return false } }
