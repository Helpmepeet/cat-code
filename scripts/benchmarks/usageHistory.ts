/**
 * Retained-history refresh benchmark on synthetic, isolated data.
 *
 *   bun scripts/benchmarks/usageHistory.ts            # whole matrix, one child per case
 *   bun scripts/benchmarks/usageHistory.ts --case cold --sources 200 --requests 500
 *
 * Every case builds its own config home and index under the OS temp directory,
 * freezes asOf and TZ, and runs the production `aggregateUsageDashboard` path
 * (discovery, indexing, replay, fitting). Retained-state figures are the
 * collector's own estimate; `peakRssMiBSampled` is the child's sampled resident peak (20 ms ticks, so a floor).
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ASOF = '2026-09-13T12:00:00.000Z'
const MODEL = 'claude-sonnet-4-6'
const arg = (name: string, fallback: number) => {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? Number(process.argv[at + 1]) : fallback
}
const caseName = process.argv.includes('--case') ? process.argv[process.argv.indexOf('--case') + 1]! : null

type Shape = { sources: number; requests: number; timingCalls: number }
const ts = (source: number, index: number) => new Date(Date.parse(ASOF) - 3 * 86_400_000 + (source * 7919 + index) * 1000 % (2 * 86_400_000)).toISOString()

/** One session file: requests with a tool call each, plus distinct timed model/tool calls. */
function sessionLines(source: number, shape: Shape, firstIndex = 0, count = shape.requests): string[] {
  const sessionId = `bench-${source}`
  const lines: string[] = []
  for (let i = firstIndex; i < firstIndex + count; i++) {
    const id = `${sessionId}-r${i}`
    lines.push(JSON.stringify({ type: 'assistant', sessionId, uuid: id, timestamp: ts(source, i), cwd: '/bench/project',
      message: { id, model: MODEL, usage: { input_tokens: 100 + i, output_tokens: 50, cache_read_input_tokens: 400, cache_creation_input_tokens: 20 },
        content: [{ type: 'tool_use', id: `tool-${id}`, name: 'Bash', input: {} }] } }))
    lines.push(JSON.stringify({ type: 'user', sessionId, uuid: `${id}-u`, timestamp: ts(source, i), message: { content: [{ type: 'tool_result', tool_use_id: `tool-${id}`, is_error: false }] } }))
  }
  const calls = firstIndex === 0 ? shape.timingCalls : 0
  for (let i = 0; i < calls; i++) {
    const call = `${sessionId}-c${i}`, attempt = `${call}-a1`, tool = `${call}-t`
    const sys = (subtype: string, fields: Record<string, unknown>, offset: number) => JSON.stringify({ type: 'system', subtype, sessionId, uuid: `${subtype}-${call}`, timestamp: ts(source, i + offset), schema_version: 1, ...fields })
    lines.push(sys('model_attempt_start', { call_id: call, attempt_id: attempt, attempt_index: 1, provider: 'firstParty', model: MODEL, mode: 'streaming' }, 0))
    lines.push(sys('model_attempt_end', { call_id: call, attempt_id: attempt, outcome: 'succeeded', duration_ms: 200 + (i % 50) }, 0))
    lines.push(sys('tool_execution_start', { tool_use_id: tool }, 0))
    lines.push(sys('tool_execution_end', { tool_use_id: tool, outcome: 'succeeded', duration_ms: 20 + (i % 30) }, 0))
  }
  return lines
}

function writeFixture(home: string, shape: Shape): string[] {
  const dir = join(home, 'projects', '-bench-project')
  mkdirSync(dir, { recursive: true })
  const files: string[] = []
  for (let s = 0; s < shape.sources; s++) {
    const file = join(dir, `bench-${s}.jsonl`)
    writeFileSync(file, `${sessionLines(s, shape).join('\n')}\n`)
    files.push(file)
  }
  return files
}

async function runCase(name: string): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'cat-usage-bench-'))
  process.env.CLAUDE_CONFIG_DIR = home
  process.env.TZ = 'UTC'
  // Bun reports no maxRSS, so sample resident memory while the collector yields.
  let peakRss = process.memoryUsage().rss
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 20)
  try {
    const shape: Shape = { sources: arg('sources', 200), requests: arg('requests', 500), timingCalls: arg('timing', 0) }
    const { aggregateUsageDashboard } = await import('../../src/utils/stats.js')
    const { emptyUsageIndexMetrics } = await import('../../src/utils/statsUsageIndex.js')
    const { fitUsageDashboardSnapshot } = await import('../../app/sidecar/usageSummary.js')
    const { usageDiagnosticFromError } = await import('../../app/shared/usageDiagnostic.js')
    const indexPath = join(home, 'index.sqlite')
    const files = writeFixture(home, shape)
    const run = async (label: string, asOf = ASOF) => {
      const metrics = emptyUsageIndexMetrics()
      const started = performance.now()
      let outcome: Record<string, unknown> = { ok: true }
      try { await aggregateUsageDashboard(asOf, { indexPath, finalize: fitUsageDashboardSnapshot, metrics }) }
      catch (error) { outcome = { ok: false, ...usageDiagnosticFromError(error, performance.now() - started) } }
      const { retained, ...rest } = metrics
      const round = (value: number) => Math.round(value * 10) / 10
      return { case: name, step: label, ...shape, totalMs: round(performance.now() - started), indexMs: round(rest.indexMs), replayMs: round(rest.replayMs), finalizeMs: round(rest.finalizeMs),
        sourcesChanged: rest.sourcesChanged, rowsInserted: rest.rowsInserted, rowsReplayed: rest.rowsReplayed, prefixVerifiedBytes: rest.prefixVerifiedBytes, reusedAggregate: rest.reusedAggregate,
        retainedEntries: retained.retainedEntries, retainedMiBEstimate: round(retained.retainedBytes / 1048576), peakRssMiBSampled: Math.round(Math.max(peakRss, process.memoryUsage().rss) / 1048576), ...outcome }
    }
    const out: unknown[] = []
    if (name === 'cold' || name === 'timing') out.push(await run('cold-rebuild'))
    if (name === 'cold') {
      out.push(await run('unchanged-same-day', new Date(Date.parse(ASOF) + 60_000).toISOString()))
      appendFileSync(files[0]!, `${sessionLines(0, shape, shape.requests + 1, 1).join('\n')}\n`)
      out.push(await run('append-one-record', new Date(Date.parse(ASOF) + 120_000).toISOString()))
    }
    for (const row of out) console.log(`BENCH ${JSON.stringify(row)}`)
  } finally { clearInterval(sampler); rmSync(home, { recursive: true, force: true }) }
}

if (caseName) await runCase(caseName)
else {
  const matrix: string[][] = [
    ['cold', '--sources', '200', '--requests', '500'],
    ['cold', '--sources', '1000', '--requests', '500'],
    ...[10_000, 25_000, 40_000, 60_000, 90_000, 150_000, 300_000].map(timing => ['timing', '--sources', '10', '--requests', '10', '--timing', String(timing / 10)]),
  ]
  const rows: Record<string, unknown>[] = []
  for (const args of matrix) {
    const child = spawnSync(process.execPath, [import.meta.path, '--case', ...args], { encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024 })
    for (const line of child.stdout.split('\n')) if (line.startsWith('BENCH ')) rows.push(JSON.parse(line.slice(6)))
    if (child.status !== 0) console.error(`case ${args.join(' ')} exited ${child.status}: ${child.stderr.slice(0, 500)}`)
  }
  console.log(JSON.stringify({ runtime: `bun ${Bun.version}`, platform: `${process.platform}-${process.arch}`, asOf: ASOF, rows }, null, 1))
}
