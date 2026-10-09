/**
 * Tier A runner. Bundles each probe with esbuild and runs it under Node so
 * timings come from V8, as the renderer and Electron main use. Writes one JSON
 * file per probe plus `environment.json` into a new output directory.
 *
 *   bun docs/reports/2026-10-06-performance-measurements/run.ts --out <new dir> [--probe <name>]... [--reps N] [--warmups N] [--smoke]
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { cpus, loadavg, release, tmpdir, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(here, '../../..')
const esbuild = createRequire(join(root, 'app/package.json'))('esbuild') as typeof import('esbuild')

const PROBES = ['markdown', 'raw-replay', 'tracing', 'cache'] as const
/** Reads the operator's real state; runs only when named with `--probe`. */
const OPT_IN_PROBES = ['real-data'] as const

/** Production sources the probes call or mirror. A run is rejected if any changes mid-run. */
const SOURCES = [
  'app/renderer/src/markdownRenderPlan.ts', 'app/renderer/src/markdownPlugins.ts',
  'app/renderer/src/rawMessageLog.ts', 'app/renderer/src/serverFrameBatch.ts',
  'app/main/deliveryTraceSink.ts', 'app/shared/deliveryTrace.ts', 'app/main/main.ts',
  'app/main/transcriptCache.ts', 'app/main/replayBuffer.ts',
]

const args = process.argv.slice(2)
const flag = (key: string) => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1] }
const out = flag('--out')
if (!out) throw new Error('--out <new directory> is required')
const outDir = resolve(out)
if (existsSync(outDir)) throw new Error(`refusing to overwrite ${outDir}; choose a new directory`)
const selected = args.flatMap((arg, i) => arg === '--probe' ? [args[i + 1]!] : [])
for (const name of selected) {
  if (![...PROBES, ...OPT_IN_PROBES].includes(name as never)) throw new Error(`unknown probe ${name}`)
}
const probes = selected.length > 0 ? selected : [...PROBES]
const smoke = args.includes('--smoke')
const probeConfig = {
  reps: Number(flag('--reps') ?? (smoke ? 1 : 5)),
  warmups: Number(flag('--warmups') ?? (smoke ? 0 : 1)),
  smoke,
}

const hashFiles = (paths: string[]) => Object.fromEntries(paths.map(path => [path,
  createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex'),
]))
const harnessFiles = ['run.ts', 'fixtures.ts', 'timing.ts', ...[...PROBES, ...OPT_IN_PROBES].map(p => `probes/${p}.ts`)]
  .map(path => `docs/reports/2026-10-06-performance-measurements/${path}`)
const sourcesBefore = hashFiles([...SOURCES, ...harnessFiles])

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'environment.json'), `${JSON.stringify({
  recordedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  release: release(),
  cpu: cpus()[0]?.model,
  logicalCpus: cpus().length,
  totalMemoryGiB: Math.round(totalmem() / 1024 ** 3),
  node: execFileSync('node', ['--version'], { encoding: 'utf8' }).trim(),
  bun: Bun.version,
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  loadAverageAtStart: loadavg(),
  probeConfig,
  probes,
  sourceHashes: sourcesBefore,
}, null, 2)}\n`)

const buildDir = mkdtempSync(join(tmpdir(), 'catcode-perf-build-'))
let failed = false
try {
  for (const probe of probes) {
    const outfile = join(buildDir, `${probe}.mjs`)
    await esbuild.build({
      entryPoints: [join(here, 'probes', `${probe}.ts`)],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile,
      logLevel: 'error',
      define: { 'process.env.NODE_ENV': '"production"' },
      banner: { js: "import { createRequire as __perfRequire } from 'node:module'; const require = __perfRequire(import.meta.url);" },
    })
    const started = performance.now()
    const child = spawnSync('node', [outfile], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PERF_PROBE_CONFIG: JSON.stringify(probeConfig) },
      maxBuffer: 64 * 1024 * 1024,
    })
    const seconds = ((performance.now() - started) / 1000).toFixed(1)
    if (child.status !== 0) {
      failed = true
      process.stderr.write(`[${probe}] exited ${child.status} after ${seconds}s\n${child.stderr}\n`)
      continue
    }
    const result = JSON.parse(child.stdout.trim().split('\n').at(-1)!)
    writeFileSync(join(outDir, `${probe}.json`), `${JSON.stringify({ ...result, wallSeconds: Number(seconds), loadAverageAfter: loadavg() }, null, 2)}\n`)
    process.stdout.write(`[${probe}] ${result.cases ? `${result.cases.length} cases` : 'done'} in ${seconds}s\n`)
  }
} finally {
  rmSync(buildDir, { recursive: true, force: true })
}

const sourcesAfter = hashFiles([...SOURCES, ...harnessFiles])
const changed = Object.keys(sourcesBefore).filter(path => sourcesBefore[path] !== sourcesAfter[path])
if (changed.length > 0) {
  writeFileSync(join(outDir, 'REJECTED.txt'), `Sources changed during the run:\n${changed.join('\n')}\n`)
  throw new Error(`sources changed during the run: ${changed.join(', ')}`)
}
if (failed) process.exit(1)
