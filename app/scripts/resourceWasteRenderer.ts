/**
 * Focused renderer resource comparison for the two transcript hot paths.
 * Run with `bun run scripts/benchmarks/resourceWasteRenderer.ts`.
 */
import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { TRANSCRIPT_REHYPE_PLUGINS } from '../renderer/src/markdownPlugins.js'
import { createMarkdownPlanCache, planMarkdownLeaves } from '../renderer/src/markdownRenderPlan.js'
import { MAX_MOUNTED_COMPOSITE_CHILDREN } from '../renderer/src/compositeChildWindow.js'
import { TranscriptRowsView } from '../renderer/src/TranscriptView.js'
import type { NestedTranscriptRow } from '../renderer/src/transcriptProjector.js'

const require = createRequire(fileURLToPath(new URL('../package.json', import.meta.url)))
const rehypeHighlight = require('rehype-highlight').default
const rehypeKatex = require('rehype-katex').default
const { createElement } = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

function measure(run: () => void, repetitions: number): number {
  for (let warmup = 0; warmup < 3; warmup += 1) run()
  const samples: number[] = []
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const start = performance.now()
    run()
    samples.push(performance.now() - start)
  }
  return median(samples)
}

const prose = Array.from({ length: 1_600 }, () =>
  'settled transcript words continue without syntax ',
).join('') + 'ending'
const cache = createMarkdownPlanCache()
planMarkdownLeaves('bench-prose', prose, {
  cache, rehypePlugins: TRANSCRIPT_REHYPE_PLUGINS, allowPlainTextAppend: true,
  math: true, recognizeCallouts: true,
})
let fullSource = prose
let cachedSource = prose
const fullParseMs = measure(() => {
  fullSource += ' and newly streamed words'
  planMarkdownLeaves('bench-full', fullSource, {
    rehypePlugins: TRANSCRIPT_REHYPE_PLUGINS,
    allowPlainTextAppend: true,
    math: true,
    recognizeCallouts: true,
  })
}, 12)
const incrementalMs = measure(() => {
  cachedSource += ' and newly streamed words'
  planMarkdownLeaves('bench-prose', cachedSource, {
    cache,
    rehypePlugins: TRANSCRIPT_REHYPE_PLUGINS,
    allowPlainTextAppend: true,
    math: true,
    recognizeCallouts: true,
  })
}, 12)

const fence = `\`\`\`ts\n${Array.from({ length: 180 }, (_, index) =>
  `const value${index} = { answer: ${index}, text: 'settled highlighting work' }`,
).join('\n')}\n\`\`\`\n\n$$x^2$$\n\n> [!NOTE]\n> settled callout`
const baselinePlugins: NonNullable<Parameters<typeof planMarkdownLeaves>[2]>['rehypePlugins'] = [
  [rehypeHighlight, { detect: false, ignoreMissing: true }],
  [rehypeKatex, { trust: false, strict: 'ignore', maxExpand: 1_000, maxSize: 50 }],
]
const highlightCache = createMarkdownPlanCache()
let highlightSource = fence
let baselineSource = fence
const highlightCachedMs = measure(() => {
  highlightSource += `\n\nStream tick ${highlightSource.length}`
  planMarkdownLeaves('bench-highlight', highlightSource, {
    cache: highlightCache,
    rehypePlugins: TRANSCRIPT_REHYPE_PLUGINS,
    allowPlainTextAppend: true,
    math: true,
    recognizeCallouts: true,
  })
}, 12)
const highlightFullMs = measure(() => {
  baselineSource += `\n\nStream tick ${baselineSource.length}`
  planMarkdownLeaves('bench-highlight-baseline', baselineSource, {
    rehypePlugins: baselinePlugins,
    allowPlainTextAppend: true,
    math: true,
    recognizeCallouts: true,
  })
}, 12)

const retainedHistory = 5_000
const transcriptRows: NestedTranscriptRow[] = Array.from({ length: retainedHistory }, (_, index) => ({
  sessionId: 'renderer-benchmark',
  messageId: `message-${index}`,
  frameId: `frame-${index}`,
  blockIndex: 0,
  parentToolUseId: null,
  children: [],
  id: `entry-${index}`,
  kind: 'user-text',
  role: 'user',
  content: `Historical renderer benchmark entry ${index}`,
  isReplay: true,
}))
const transcriptHtml = renderToStaticMarkup(createElement(TranscriptRowsView, { rows: transcriptRows }))

console.log(JSON.stringify({
  prose: { characters: prose.length, fullParseMedianMs: fullParseMs, cachedAppendMedianMs: incrementalMs },
  highlightedFence: { characters: fence.length, uncachedFullParseMedianMs: highlightFullMs, cachedFullParseMedianMs: highlightCachedMs },
  outerTranscript: {
    modelEntries: retainedHistory,
    viewportRowCap: MAX_MOUNTED_COMPOSITE_CHILDREN,
    mountedDomEntries: (transcriptHtml.match(/data-row-key=/g) ?? []).length,
  },
}, null, 2))
