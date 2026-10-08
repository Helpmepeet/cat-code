/**
 * Streaming Markdown and tab-return parsing through the production planner and
 * transcript plugins, with the options `BoundedMarkdown` passes for transcript
 * rows. Times are planner calls only: no React render, layout or paint.
 */
import {
  createMarkdownPlanCache,
  planMarkdownLeaves,
  type MarkdownPlanCache,
} from '../../../../app/renderer/src/markdownRenderPlan.js'
import { TRANSCRIPT_REHYPE_PLUGINS } from '../../../../app/renderer/src/markdownPlugins.js'
import {
  APPEND_SHAPES,
  realisticReply,
  settledPrefix,
  streamPieces,
  typescriptBlock,
} from '../fixtures.js'
import { emit, median, percentile, probeConfig, repeat, round, summarize, type CaseResult } from '../timing.js'

const config = probeConfig()
const cases: CaseResult[] = []
const APPENDS = config.smoke ? 4 : 24

type Path = 'unattributed'

/**
 * Planner calls are timed without attributing internal transformation paths:
 * tree identity is not evidence of which plugin transforms ran.
 */
function plan(cache: MarkdownPlanCache, source: string): { ms: number; path: Path } {
  const start = performance.now()
  planMarkdownLeaves('perf-row', source, {
    rehypePlugins: TRANSCRIPT_REHYPE_PLUGINS,
    allowPlainTextAppend: true,
    math: true,
    recognizeCallouts: true,
    cache,
  })
  const ms = performance.now() - start
  return { ms, path: 'unattributed' }
}

/** Primes a fresh cache untimed, then times `APPENDS` successive appends; a repetition scores the median append. */
function appendCase(name: string, params: Record<string, unknown>, base: string, suffix: string): void {
  const samples = repeat(config, () => {
    const cache = createMarkdownPlanCache()
    let source = base
    plan(cache, source)
    const times: number[] = []
    for (let i = 0; i < APPENDS; i++) {
      source += suffix
      const result = plan(cache, source)
      times.push(result.ms)
    }
    return median(times)
  })
  cases.push(summarize(name, { ...params, appendsPerRep: APPENDS, scoredValue: 'median ms per append' }, samples))
}

const prefix = settledPrefix(config.smoke ? 4_000 : 33_600)

for (const [shape, { initial, suffix }] of Object.entries(APPEND_SHAPES)) {
  appendCase(`append-shape/${shape}`, { prefixCharacters: prefix.length }, `${prefix}${initial}`, suffix)
}

for (const characters of config.smoke ? [2_000] : [15_500, 16_500, 32_000, 64_000]) {
  const base = `\`\`\`ts\n${typescriptBlock(characters)}\n\`\`\`\n\nThe **first** item`
  appendCase(`settled-code/${characters}`, { codeCharacters: characters }, base, ' plus **bold** text')
}

for (const characters of config.smoke ? [2_000] : [16_000, 64_000, 128_000, 256_000]) {
  const base = `${prefix}\`\`\`ts\n${typescriptBlock(characters)}`
  appendCase(`open-fence/${characters}`, { prefixCharacters: prefix.length, openCodeCharacters: characters }, base, '\nconst value = 1;')
}

// Whole reply streamed from empty, every update timed. The scored value is the
// total; per-update distribution and reuse come from the last repetition.
const reply = realisticReply(config.smoke ? 1_500 : 12_000)
for (const wordsPerPiece of [1, 4]) {
  const pieces = streamPieces(reply, wordsPerPiece)
  let last: { times: number[]; paths: Record<Path, number> } = {
    times: [], paths: { unattributed: 0 },
  }
  const streamConfig = { ...config, reps: Math.min(config.reps, 3) }
  const samples = repeat(streamConfig, () => {
    const cache = createMarkdownPlanCache()
    let source = ''
    const times: number[] = []
    const paths: Record<Path, number> = { unattributed: 0 }
    for (const piece of pieces) {
      source += piece
      const result = plan(cache, source)
      times.push(result.ms)
      paths[result.path]++
    }
    last = { times, paths }
    return times.reduce((sum, value) => sum + value, 0)
  })
  cases.push(summarize(`stream-reply/${wordsPerPiece}-word-pieces`, {
    replyCharacters: reply.length, updates: pieces.length, scoredValue: 'total ms for the whole reply',
  }, samples, {
    updatesByPath: last.paths,
    perUpdateP50Ms: round(percentile(last.times, 50)),
    perUpdateP95Ms: round(percentile(last.times, 95)),
    perUpdateMaxMs: round(Math.max(...last.times)),
    updatesOver16_7Ms: last.times.filter(t => t > 16.7).length,
  }))
}

// Tab return. A remount creates a fresh cache, so the first plan is cold.
// The primed-cache call shows what a cache surviving the remount would still
// cost with the current planner, which parses before comparing settled bodies.
const longReply = realisticReply(config.smoke ? 3_000 : 28_822)
cases.push(summarize('tab-return/cold-plan', { replyCharacters: longReply.length }, repeat(config, () => {
  return plan(createMarkdownPlanCache(), longReply).ms
})))
cases.push(summarize('tab-return/primed-cache-same-source', { replyCharacters: longReply.length }, repeat(config, () => {
  const cache = createMarkdownPlanCache()
  plan(cache, longReply)
  return plan(cache, longReply).ms
})))

emit('markdown', cases, [
  'Planner calls only; React reconciliation, layout and paint are not included.',
  'The planner API exposes no transform-path signal; tree identity does not prove which plugin transforms ran.',
  'Stream pieces are synthetic word groups with leading whitespace, not sampled provider deltas.',
])
