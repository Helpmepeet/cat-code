/** Builds an isolated Electron benchmark; --run is intentionally required to launch it. */
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { manifest } from '../../docs/reports/2026-09-12-live-streaming-measurements/fixture.js'

const run = process.argv.includes('--run')
const requestedWorkload = valueAfter('--workload')
const requestedPolicy = valueAfter('--policy')
const workloads = requestedWorkload ? manifest.workloads.filter(item => item.id === requestedWorkload) : manifest.workloads
const policies = requestedPolicy ? manifest.policies.filter(item => item === requestedPolicy) : manifest.policies
if (workloads.length === 0 || policies.length === 0) throw new Error('unknown workload or policy')

const appRoot = resolve(import.meta.dir, '..')
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
  const sources = ['main/liveFrameBatcher.ts', 'main/attachmentGate.ts', 'renderer/src/App.tsx', 'preload/preload.ts', '../docs/reports/2026-09-12-live-streaming-measurements/fixture.ts']
  const sourceHashes = Object.fromEntries(sources.map(path => [path, sha256(readFileSync(resolve(appRoot, path))) ]))
  if (!run) {
    process.stdout.write(`${JSON.stringify({ prepared: true, launched: false, workloads: workloads.map(item => item.id), policies, sourceHashes })}\n`)
    process.exit(0)
  }
  const electron = resolve(appRoot, 'node_modules/.bin/electron')
  for (let repetition = 0; repetition < manifest.repetitions; repetition++) {
    const rotated = [...policies.slice(repetition % policies.length), ...policies.slice(0, repetition % policies.length)]
    for (const workload of workloads) for (const policy of rotated) {
      const sample = join(scratch, `sample-${repetition}-${workload.id}-${policy}`)
      mkdirSync(sample)
      const child = spawnSync(electron, [join(bundleOut, 'main.js')], {
        cwd: sample, encoding: 'utf8', timeout: manifest.warmupMs + manifest.durationMs + 30_000,
        env: allowlistedEnv({
          CLAUDE_CONFIG_DIR: join(sample, 'config'), CATCODE_STREAMING_BENCHMARK_RUN_DIR: sample,
          CATCODE_STREAMING_BENCHMARK_RENDERER_OUT: rendererOut, CATCODE_STREAMING_BENCHMARK_PRELOAD: join(bundleOut, 'preload.cjs'),
          CATCODE_STREAMING_BENCHMARK_WORKLOAD: workload.id, CATCODE_STREAMING_BENCHMARK_POLICY: policy,
        }),
      })
      if (child.error || child.status !== 0) throw new Error(`sample failed: ${child.error?.message ?? child.stderr}`)
      const result = JSON.parse(readFileSync(join(sample, 'result.json'), 'utf8'))
      process.stdout.write(`${JSON.stringify({ repetition, ...result, sourceHashes })}\n`)
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

async function bundle(entry: string, outdir: string, name: string, format: 'esm' | 'cjs', define?: Record<string, string>) {
  const result = await Bun.build({ entrypoints: [entry], outdir, target: 'node', format, external: ['electron'], naming: name, define })
  if (!result.success) throw new Error(result.logs.map(item => item.message).join('\n'))
}
function valueAfter(flag: string) { const index = process.argv.indexOf(flag); return index < 0 ? undefined : process.argv[index + 1] }
function sha256(value: Uint8Array) { return createHash('sha256').update(value).digest('hex') }
function allowlistedEnv(extra: Record<string, string>) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', LANG: process.env.LANG ?? 'C.UTF-8' }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  return { ...env, ...extra }
}
