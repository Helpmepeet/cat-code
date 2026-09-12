/** Validate and summarize one immutable focused-Electron benchmark output directory. */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import frozen from './manifest.json'

type Sample = {
  repetition: number; schemaVersion: number; tier: string; workload: string; policy: string
  fixtureHash: string; deliveredFrames: number; expectedCommittedRawFrames: number
  observedCommittedRawFrames: number; sendCount: number; dispatchCount: number; commitCount: number
  observerOverflowed: boolean; mainCpuMicros: number
  electronCpu: { valid: boolean; reason: string | null; processes: Array<{ type: string; cumulativeDeltaSeconds: number | null }> }
  latencyMs: number[]; clockAlignmentUncertaintyMs: number
  expectedTraceHash: string; observedTraceHash: string; frameOrderVerified: boolean
  sourceHashes: Record<string, string>
}

const args = process.argv.slice(2)
const requestedInput = valueAfter('--input') ?? (args[0] && !args[0].startsWith('--') ? args[0] : undefined)
if (!requestedInput) throw new Error('usage: bun summarize-electron.ts --input DIR [--json-out FILE] [--markdown-out FILE]')
const input = resolve(requestedInput)
const policies = frozen.manifest.policies
const workloads = frozen.manifest.workloads.map(item => item.id)
const files = readdirSync(input).filter(name => /^sample-.*\.json$/.test(name)).sort()
if (files.length === 0) throw new Error(`no sample-*.json files in ${input}`)
const samples = files.map(file => validate(JSON.parse(readFileSync(resolve(input, file), 'utf8')), file))
const expectedKeys = new Set<string>()
for (let repetition = 0; repetition < frozen.manifest.repetitions; repetition++)
  for (const workload of workloads) for (const policy of policies) expectedKeys.add(key(repetition, workload, policy))
const actualKeys = new Set(samples.map(sample => key(sample.repetition, sample.workload, sample.policy)))
if (actualKeys.size !== samples.length) throw new Error('duplicate repetition/workload/policy sample')
const missing = [...expectedKeys].filter(item => !actualKeys.has(item))
const unexpected = [...actualKeys].filter(item => !expectedKeys.has(item))

const sourceSignature = stableEntries(samples[0]!.sourceHashes)
for (const sample of samples) if (stableEntries(sample.sourceHashes) !== sourceSignature) throw new Error('sourceHashes differ across samples')
const byKey = new Map(samples.map(sample => [key(sample.repetition, sample.workload, sample.policy), sample]))
const sampleRows = samples.map(sample => ({
  repetition: sample.repetition, workload: sample.workload, policy: sample.policy,
  combinedElectronCpuMicros: combinedCpu(sample), sendCount: sample.sendCount,
  dispatchCount: sample.dispatchCount, commitCount: sample.commitCount,
  latencyP95Ms: nearestRank(sample.latencyMs, 0.95), latencyP99Ms: nearestRank(sample.latencyMs, 0.99),
  clockAlignmentUncertaintyMs: sample.clockAlignmentUncertaintyMs,
}))
const groups = workloads.flatMap(workload => policies.map(policy => {
  const rows = sampleRows.filter(row => row.workload === workload && row.policy === policy)
  return rows.length === 0 ? null : {
    workload, policy, samples: rows.length,
    combinedElectronCpuMicros: aggregate(rows.map(row => row.combinedElectronCpuMicros)),
    sendCount: aggregate(rows.map(row => row.sendCount)),
    commitCount: aggregate(rows.map(row => row.commitCount)),
    latencyP95Ms: aggregate(rows.map(row => row.latencyP95Ms)),
    latencyP99Ms: aggregate(rows.map(row => row.latencyP99Ms)),
    clockAlignmentUncertaintyMs: aggregate(rows.map(row => row.clockAlignmentUncertaintyMs)),
  }
}).filter(Boolean))
const paired = samples.flatMap(sample => {
  if (sample.policy === 'original' || sample.policy === '0') return []
  return ['original', '0'].flatMap(baselinePolicy => {
    const baseline = byKey.get(key(sample.repetition, sample.workload, baselinePolicy))
    if (!baseline) return []
    const cpu = combinedCpu(sample), baselineCpu = combinedCpu(baseline)
    return [{ repetition: sample.repetition, workload: sample.workload, policy: sample.policy, baselinePolicy,
      cpuReductionPercent: baselineCpu === 0 ? null : (baselineCpu - cpu) / baselineCpu * 100,
      addedP95Ms: nearestRank(sample.latencyMs, .95) - nearestRank(baseline.latencyMs, .95),
      addedP99Ms: nearestRank(sample.latencyMs, .99) - nearestRank(baseline.latencyMs, .99),
    }]
  })
})
const summary = {
  schemaVersion: 1, input, status: missing.length || unexpected.length ? 'incomplete-pilot-matrix' : 'complete-frozen-matrix',
  expectedSamples: expectedKeys.size, observedSamples: samples.length, missing, unexpected,
  scope: 'Instrumented focused Electron delivery pipeline; excludes engine/supervisor/host workers, production recovery/health timers, and operational logging outside delivery tracing.',
  cpuAccounting: 'Combined Electron CPU sums Browser and Tab cumulative CPU deltas only; mainCpuMicros is validated but never added.',
  clockCaveat: 'Arrival-to-commit percentiles depend on cross-process monotonic-clock calibration; uncertainty is reported per sample and is not subtracted.',
  sourceHashes: samples[0]!.sourceHashes, samples: sampleRows, groups, paired,
}
const json = `${JSON.stringify(summary, null, 2)}\n`
const markdown = renderMarkdown(summary)
const jsonOut = valueAfter('--json-out'), markdownOut = valueAfter('--markdown-out')
if (jsonOut) writeFileSync(resolve(jsonOut), json)
if (markdownOut) writeFileSync(resolve(markdownOut), markdown)
if (!jsonOut && !markdownOut) process.stdout.write(`${json}\n${markdown}`)
else if (!jsonOut) process.stdout.write(json)
else if (!markdownOut) process.stdout.write(markdown)

function validate(value: any, file: string): Sample {
  const fail = (message: string): never => { throw new Error(`${file}: ${message}`) }
  if (!value || value.schemaVersion !== 1 || value.tier !== 'focused-electron-delivery-pipeline') fail('unsupported schema/tier')
  if (!Number.isSafeInteger(value.repetition) || value.repetition < 0) fail('invalid repetition')
  if (!workloads.includes(value.workload) || !policies.includes(value.policy)) fail('unknown workload/policy')
  const fixture = frozen.fixtures.find(item => item.workload === value.workload)!
  if (value.fixtureHash !== fixture.hash || value.deliveredFrames !== fixture.arrivalFrames) fail('fixture hash/count mismatch')
  if (!Number.isSafeInteger(value.expectedCommittedRawFrames) || value.expectedCommittedRawFrames < 0 || value.observedCommittedRawFrames !== value.expectedCommittedRawFrames || value.latencyMs?.length !== value.expectedCommittedRawFrames) fail('commit/latency count mismatch')
  if (value.observerOverflowed !== false) fail('observer overflowed')
  if (value.frameOrderVerified !== true || value.expectedTraceHash !== value.observedTraceHash || typeof value.expectedTraceHash !== 'string') fail('trace order/hash mismatch')
  for (const name of ['sendCount', 'dispatchCount', 'commitCount', 'mainCpuMicros', 'clockAlignmentUncertaintyMs'])
    if (!finiteNonnegative(value[name])) fail(`invalid ${name}`)
  if (!Array.isArray(value.latencyMs) || value.latencyMs.some((item: unknown) => !finiteNonnegative(item))) fail('invalid latency')
  if (value.electronCpu?.valid !== true || value.electronCpu.reason !== null || !Array.isArray(value.electronCpu.processes) || value.electronCpu.processes.length === 0) fail('invalid Electron CPU snapshot')
  for (const process of value.electronCpu.processes) if (!['Browser', 'Tab'].includes(process?.type) || !finiteNonnegative(process.cumulativeDeltaSeconds)) fail('invalid Browser/Tab cumulative CPU delta')
  if (!value.electronCpu.processes.some((item: any) => item.type === 'Browser') || !value.electronCpu.processes.some((item: any) => item.type === 'Tab')) fail('Electron CPU snapshot must include Browser and Tab')
  if (!value.sourceHashes || typeof value.sourceHashes !== 'object' || Array.isArray(value.sourceHashes) || Object.keys(value.sourceHashes).length === 0 || Object.values(value.sourceHashes).some(hash => !/^[0-9a-f]{64}$/.test(String(hash)))) fail('invalid source hashes')
  return value
}
function finiteNonnegative(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }
function combinedCpu(sample: Sample) { return sample.electronCpu.processes.reduce((sum, item) => sum + item.cumulativeDeltaSeconds! * 1_000_000, 0) }
function nearestRank(values: number[], percentile: number) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)]! }
function median(values: number[]) { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2 }
function aggregate(values: number[]) { return { median: median(values), min: Math.min(...values), max: Math.max(...values) } }
function key(repetition: number, workload: string, policy: string) { return `${repetition}/${workload}/${policy}` }
function stableEntries(value: Record<string, string>) { return JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) }
function valueAfter(flag: string) { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1] }
function n(value: number | null) { return value === null ? 'n/a' : Number(value.toFixed(3)).toString() }
function renderMarkdown(value: typeof summary) {
  const lines = [`# Focused Electron streaming summary`, '', `Status: **${value.status}** (${value.observedSamples}/${value.expectedSamples} samples).`, '', value.scope, '', value.cpuAccounting, '', value.clockCaveat, '', '## Per workload and policy', '', '| Workload | Policy | n | CPU µs median [range] | Sends median [range] | Commits median [range] | p95 ms median [range] | p99 ms median [range] | Clock uncertainty ms median [range] |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|']
  for (const row of value.groups as any[]) lines.push(`| ${row.workload} | ${row.policy} | ${row.samples} | ${fmt(row.combinedElectronCpuMicros)} | ${fmt(row.sendCount)} | ${fmt(row.commitCount)} | ${fmt(row.latencyP95Ms)} | ${fmt(row.latencyP99Ms)} | ${fmt(row.clockAlignmentUncertaintyMs)} |`)
  lines.push('', '## Paired comparisons', '', '| Rep | Workload | Policy | Baseline | CPU reduction % | Added p95 ms | Added p99 ms |', '|---:|---|---:|---:|---:|---:|---:|')
  for (const row of value.paired) lines.push(`| ${row.repetition} | ${row.workload} | ${row.policy} | ${row.baselinePolicy} | ${n(row.cpuReductionPercent)} | ${n(row.addedP95Ms)} | ${n(row.addedP99Ms)} |`)
  if (value.missing.length) lines.push('', `Missing: ${value.missing.join(', ')}`)
  if (value.unexpected.length) lines.push('', `Unexpected: ${value.unexpected.join(', ')}`)
  return `${lines.join('\n')}\n`
}
function fmt(value: { median: number; min: number; max: number }) { return `${n(value.median)} [${n(value.min)}–${n(value.max)}]` }
