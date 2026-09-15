import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const root = dirname(import.meta.path)
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
const smoke = process.argv.includes('--smoke')
const config = mkdtempSync(join(root, smoke ? 'smoke-config-' : 'measured-config-'))
const fakeHome = join(root, 'isolated-home')
mkdirSync(config, { recursive: true })
mkdirSync(fakeHome, { recursive: true })
process.env.CLAUDE_CONFIG_DIR = config
process.env.HOME = fakeHome
process.env.CLAUDE_CODE_SIMPLE = '1'
process.env.NODE_ENV = 'test'
for (const name of [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'OPENAI_API_KEY',
]) delete process.env[name]

for (const variant of ['before', 'after']) {
  const source = readFileSync(manifest.blobs[variant].path)
  if (createHash('sha256').update(source).digest('hex') !== manifest.blobs[variant].sha256) {
    throw new Error(`${variant} blob differs from the recorded git source`)
  }
}
// Any unexpected network path fails without issuing a request.
globalThis.fetch = async () => { throw new Error('Network is disabled in this benchmark') }
const before = await import(manifest.blobs.before.path)
const after = await import(manifest.blobs.after.path)
const { utimesSync } = await import('node:fs')

const today = new Date()
today.setHours(12, 0, 0, 0)
const anchorDate = today.toDateString()
const stages = smoke ? [12] : [128, 384, 768]
const messagesPerFile = smoke ? 16 : 96
const payload = 'synthetic-local-history '.repeat(34)
let sessionsWritten = 0
let transcriptFiles = 0
let transcriptBytes = 0
const project = join(config, 'projects', 'synthetic-growing-history')
mkdirSync(project, { recursive: true })

function day(daysAgo: number): Date {
  const date = new Date(today)
  date.setDate(date.getDate() - daysAgo)
  return date
}
function transcript(sessionId: string, age: number, sidechain: boolean): string {
  const timestamp = day(age)
  const entries = Array.from({ length: messagesPerFile }, (_, index) => {
    const time = new Date(timestamp.getTime() + index * 1000)
    return {
      type: 'assistant', uuid: `${sessionId}-${index}`,
      parentUuid: index ? `${sessionId}-${index - 1}` : null,
      isSidechain: sidechain, sessionId, cwd: '/synthetic',
      userType: 'external', version: 'benchmark', timestamp: time.toISOString(),
      message: {
        id: `${sessionId}-response-${Math.floor(index / 3)}`,
        type: 'message', role: 'assistant', model: 'synthetic-benchmark-model',
        content: [{ type: 'text', text: payload }],
        usage: {
          input_tokens: 100 + index,
          output_tokens: 10 + index % 3,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 80,
        },
      },
    }
  })
  return entries.map(entry => JSON.stringify(entry)).join('\n') + '\n'
}
function addFile(path: string, content: string, modified: Date): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  utimesSync(path, modified, modified)
  transcriptFiles++
  transcriptBytes += Buffer.byteLength(content)
}
function growTo(sessionCount: number): void {
  for (let index = sessionsWritten; index < sessionCount; index++) {
    const id = `session-${index.toString().padStart(5, '0')}`
    // Recent overlap, monthly-only history, and old/resumed history share one
    // stable mix at every stage. Old large resumed files exercise the header gate.
    const bucket = index % 20
    const age = bucket < 11 ? bucket % 7 : bucket < 17 ? 8 + bucket : 45
    const modified = bucket >= 17 && index % 2 === 0 ? day(0) : day(age)
    addFile(join(project, `${id}.jsonl`), transcript(id, age, false), modified)
    if (index % 4 === 0) {
      addFile(join(project, id, 'subagents', `agent-${id}.jsonl`), transcript(`${id}-child`, age, true), modified)
    }
  }
  sessionsWritten = sessionCount
}

const operations = {
  before: async () => {
    const [seven, thirty] = await Promise.all([
      before.aggregateClaudeCodeStatsForRange('7d'),
      before.aggregateClaudeCodeStatsForRange('30d'),
    ])
    return { '7d': seven, '30d': thirty }
  },
  after: async () => after.aggregateClaudeCodeStatsForRanges(['7d', '30d']),
}
type Variant = keyof typeof operations
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item
  return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
})
function validate(outputs: unknown[], expected: unknown): void {
  for (const output of outputs) {
    if (!isDeepStrictEqual(output, expected)) throw new Error('Before/after complete outputs differ')
  }
}
async function sample(variant: Variant, repetitions: number, expected: unknown) {
  const cpuStart = process.cpuUsage()
  const elapsedStart = performance.now()
  const outputs: unknown[] = []
  for (let repeat = 0; repeat < repetitions; repeat++) outputs.push(await operations[variant]())
  const elapsedMs = performance.now() - elapsedStart
  const cpu = process.cpuUsage(cpuStart)
  validate(outputs, expected) // exact validation is outside the measured interval
  return {
    variant, repetitions, elapsedMs,
    cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000,
    cpuTotalMs: (cpu.user + cpu.system) / 1000,
    elapsedMsPerPass: elapsedMs / repetitions,
    cpuMsPerPass: (cpu.user + cpu.system) / 1000 / repetitions,
  }
}
const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}
const results: unknown[] = []
for (const sessions of stages) {
  if (new Date().toDateString() !== anchorDate) throw new Error('Date changed during benchmark; rerun on a stable day')
  growTo(sessions)
  const expected = await operations.before()
  validate([await operations.after()], expected)
  const digest = createHash('sha256').update(canonical(expected)).digest('hex')
  const corpus = { sessions, transcriptFiles, transcriptBytes, messagesPerFile }
  if (smoke) {
    console.log(JSON.stringify({ mode: 'smoke', outputParity: true, outputSha256: digest, corpus, blobs: manifest.blobs }, null, 2))
    continue
  }
  // Calibration is recorded separately and selects the same batch size for
  // both variants. Every sample performs at least two complete aggregations.
  let repetitions = 2
  const calibration = []
  while (true) {
    const calibrated = await sample('before', repetitions, expected)
    calibration.push(calibrated)
    if (calibrated.elapsedMs >= 750 || repetitions >= 16) break
    repetitions *= 2
  }
  for (let warmup = 0; warmup < 2; warmup++) {
    const order: Variant[] = warmup % 2 ? ['after', 'before'] : ['before', 'after']
    for (const variant of order) validate([await operations[variant]()], expected)
  }
  const samples = []
  for (let pair = 0; pair < 6; pair++) {
    const order: Variant[] = pair % 2 ? ['after', 'before'] : ['before', 'after']
    for (const variant of order) {
      samples.push({ pair: pair + 1, order: order.join('/'), ...await sample(variant, repetitions, expected) })
    }
  }
  const summary = Object.fromEntries((['before', 'after'] as const).map(variant => {
    const selected = samples.filter(item => item.variant === variant)
    return [variant, {
      medianElapsedMsPerPass: median(selected.map(item => item.elapsedMsPerPass)),
      medianCpuMsPerPass: median(selected.map(item => item.cpuMsPerPass)),
      minElapsedMsPerPass: Math.min(...selected.map(item => item.elapsedMsPerPass)),
      maxElapsedMsPerPass: Math.max(...selected.map(item => item.elapsedMsPerPass)),
    }]
  }))
  const result = {
    corpus, outputParity: true, outputSha256: digest, repetitions, calibration, samples, summary,
    reductionsPercent: {
      elapsed: 100 * (1 - summary.after!.medianElapsedMsPerPass / summary.before!.medianElapsedMsPerPass),
      cpu: 100 * (1 - summary.after!.medianCpuMsPerPass / summary.before!.medianCpuMsPerPass),
    },
  }
  results.push(result)
  writeFileSync(join(root, 'results.json'), JSON.stringify({
    manifest, date: new Date().toISOString(), bun: Bun.version,
    arch: process.arch, platform: process.platform, stages: results,
  }, null, 2) + '\n')
  console.log(JSON.stringify({ corpus, repetitions, summary, reductionsPercent: result.reductionsPercent }))
}
