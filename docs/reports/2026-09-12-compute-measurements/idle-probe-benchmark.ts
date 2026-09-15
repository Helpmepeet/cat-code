import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cpus, release } from 'node:os'

// Execute source snapshots without importing the account engine or its credentials.
const root = resolve(import.meta.dir, '../../..')
const paths = {
  pool: 'src/services/api/codexAccountPool.ts',
  refresh: 'src/services/api/codexTokenRefresh.ts',
}
const sources = Object.fromEntries(Object.entries(paths).map(([name, path]) => [
  name, readFileSync(resolve(root, path), 'utf8'),
]))
const fragments = {
  getPoolStatus: between(sources.pool!, 'export function getPoolStatus()', 'export function getPoolAccountsForLeaseSelection()'),
  runQuarantineProbeOnce: between(sources.refresh!, 'export async function runQuarantineProbeOnce()', 'export async function persistNextQuarantineProbe('),
}
const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })
const stripExport = (source: string) => transpiler.transformSync(source.replace(/^export /, ''))
let forbiddenIoCalls = 0
const denyVaultRead = () => {
  forbiddenIoCalls++
  throw new Error('Vault reads are forbidden in this healthy-pool benchmark')
}
function createProbe(accountCount: number): () => Promise<unknown[]> {
  const pool = {
    accounts: Array.from({ length: accountCount }, (_, index) => ({
      accountId: `synthetic-${index}`, status: 'healthy', source: 'vault',
      accessToken: 'synthetic', refreshToken: 'synthetic',
      vaultFilePath: '/synthetic-unread-vault', expiresAt: 0, lastUsedAt: 0,
    })),
    activeIndex: accountCount ? 0 : -1,
    initialized: true,
  }
  const getPoolStatus = new Function('pool', `${stripExport(fragments.getPoolStatus)}\nreturn getPoolStatus`)(pool)
  return new Function('getPoolStatus', 'readVault', `
    let quarantineProbeInFlight = false;
    ${stripExport(fragments.runQuarantineProbeOnce)}
    return runQuarantineProbeOnce;
  `)(getPoolStatus, denyVaultRead)
}

const output = process.argv[2]
if (!output) throw new Error('usage: bun idle-probe-benchmark.ts OUTPUT.json')
const checksPerSample = 200_000
const warmupChecks = 20_000
const repetitions = 7
const operations = [
  { name: 'async-loop-control', accountCount: null, run: async () => [] },
  ...[1, 8, 32].map(accountCount => ({ name: `healthy-${accountCount}`, accountCount, run: createProbe(accountCount) })),
]
for (const operation of operations) {
  for (let index = 0; index < warmupChecks; index++) await operation.run()
}

const samples: Array<{
  repetition: number; name: string; accountCount: number | null;
  checks: number; cpuMicros: number; elapsedMs: number;
}> = []
for (let repetition = 0; repetition < repetitions; repetition++) {
  const ordered = repetition % 2 ? [...operations].reverse() : operations
  for (const operation of ordered) {
    const startCpu = process.cpuUsage()
    const startTime = performance.now()
    let nonemptyResults = 0
    for (let check = 0; check < checksPerSample; check++) {
      const result = await operation.run()
      if (result.length !== 0) nonemptyResults++
    }
    const elapsedMs = performance.now() - startTime
    const cpu = process.cpuUsage(startCpu)
    if (nonemptyResults || forbiddenIoCalls) throw new Error('Healthy-path invariant failed')
    samples.push({ repetition, name: operation.name, accountCount: operation.accountCount,
      checks: checksPerSample, cpuMicros: cpu.user + cpu.system, elapsedMs })
  }
}
for (const [name, path] of Object.entries(paths)) {
  if (sources[name] !== readFileSync(resolve(root, path), 'utf8')) throw new Error(`Source changed: ${path}`)
}
const groups = operations.map(operation => {
  const values = samples.filter(sample => sample.name === operation.name).map(sample => sample.cpuMicros / sample.checks)
  return { name: operation.name, accountCount: operation.accountCount,
    cpuMicrosPerCheck: { median: median(values), min: Math.min(...values), max: Math.max(...values) },
    illustrativeBodyCpuMsPerHour: operation.accountCount === null ? null : {
      fourSessions: median(values) * 4 * 3600 / 1000,
      eightSessions: median(values) * 8 * 3600 / 1000,
    },
  }
})
const result = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  scope: 'Warmed, tight-loop CPU of the healthy quarantine-probe function body from exact source snapshots. Includes async loop/validation overhead. Excludes timer dispatch, OS wakeups, engine background work, quarantined recovery and energy. No before/after scheduler comparison.',
  environment: { runtime: Bun.version, platform: process.platform, arch: process.arch,
    osRelease: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length },
  fixture: { checksPerSample, warmupChecks, repetitions, accountCounts: [1, 8, 32],
    order: 'forward/reverse alternation', credentials: 'synthetic only',
    imports: 'account engine not imported; only the captured pure status accessor and probe function execute' },
  sources: Object.fromEntries(Object.entries(paths).map(([name, path]) => [path, sha256(sources[name]!)])),
  fragmentHashes: Object.fromEntries(Object.entries(fragments).map(([name, source]) => [name, sha256(source)])),
  forbiddenIoCalls, samples, groups,
}
writeFileSync(resolve(output), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
console.log(JSON.stringify({ samples: samples.length, forbiddenIoCalls, groups }, null, 2))

function between(source: string, start: string, end: string): string {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length)
  if (first < 0 || last <= first) throw new Error(`Source boundary unavailable: ${start}`)
  return source.slice(first, last).trim()
}
function sha256(source: string): string { return createHash('sha256').update(source).digest('hex') }
function median(values: number[]): number { return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]! }
