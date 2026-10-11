/**
 * Tier B: read-only sampling of the operator's own Cat Code desktop state.
 *
 * Reads `~/.cat-code/desktop/logs` and the transcript cache directories and
 * emits aggregates only: counts, sizes, distributions and timings. No message
 * text, identifiers or paths leave this process. Cache files are read with
 * `readFileSync` + `JSON.parse`, never `readCache`, because `readCache`
 * deletes any file it rejects.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  createMarkdownPlanCache,
  planMarkdownLeaves,
  type MarkdownPlanCache,
} from '../../../../app/renderer/src/markdownRenderPlan.js'
import { TRANSCRIPT_REHYPE_PLUGINS } from '../../../../app/renderer/src/markdownPlugins.js'
import { streamPieces } from '../fixtures.js'
import { percentile, probeConfig, round } from '../timing.js'

const config = probeConfig()
const desktop = join(homedir(), '.cat-code', 'desktop')
const logs = join(desktop, 'logs')

function distribution(values: number[]) {
  if (values.length === 0) return { n: 0 }
  return {
    n: values.length,
    p50: round(percentile(values, 50)),
    p90: round(percentile(values, 90)),
    p99: round(percentile(values, 99)),
    max: round(Math.max(...values)),
  }
}

function jsonLines(path: string, visit: (record: Record<string, unknown>) => void): void {
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue
    try { visit(JSON.parse(line)) } catch { /* a torn final line is expected in a live file */ }
  }
}

const files = readdirSync(logs)

// ── Operational events: how often each trigger happens ─────────────────────────
const EVENTS = [
  'app.start', 'window.created', 'renderer.navigation.started', 'renderer.load.ready', 'renderer.process.gone',
  'session.restore.completed', 'session.turn.started', 'session.close.requested', 'app.parked.windowless',
  'app.shutdown.started', 'log.suppressed',
]
const eventCounts: Record<string, number> = Object.fromEntries(EVENTS.map(e => [e, 0]))
const restoreMessageCounts: number[] = []
const goneReasons: Record<string, number> = {}
let firstTimestamp = ''
let lastTimestamp = ''
const operationalFiles = files.filter(name => name.startsWith('operational-'))
for (const name of operationalFiles) {
  jsonLines(join(logs, name), record => {
    const timestamp = String(record.timestamp ?? '')
    if (timestamp && (!firstTimestamp || timestamp < firstTimestamp)) firstTimestamp = timestamp
    if (timestamp > lastTimestamp) lastTimestamp = timestamp
    const event = String(record.event)
    if (event in eventCounts) eventCounts[event]!++
    const fields = (record.fields ?? {}) as Record<string, unknown>
    if (event === 'session.restore.completed' && typeof fields.messageCount === 'number') restoreMessageCounts.push(fields.messageCount)
    if (event === 'renderer.process.gone') goneReasons[String(fields.reason)] = (goneReasons[String(fields.reason)] ?? 0) + 1
  })
}

// ── Delivery traces: partial share, sequence spacing, replay and loss records ──
const kindCounts: Record<string, number> = {}
const flushReasons: Record<string, number> = {}
const recordKinds: Record<string, number> = {}
const replayRecordsByFlush: Record<string, number> = {}
const finishedSequences = new Map<string, number[]>()
const streamFrameCounts = new Map<string, number>()
let traceBytes = 0
let traceFirst = ''
let traceLast = ''
const traceFiles = files.filter(name => name.startsWith('delivery-trace-'))
for (const name of traceFiles) {
  traceBytes += statSync(join(logs, name)).size
  jsonLines(join(logs, name), record => {
    const recordKind = String(record.recordKind)
    recordKinds[recordKind] = (recordKinds[recordKind] ?? 0) + 1
    const wall = String(record.wallTimestamp ?? '')
    if (wall && (!traceFirst || wall < traceFirst)) traceFirst = wall
    if (wall > traceLast) traceLast = wall
    if (recordKind !== 'delivery.trace') return
    const messageKind = String(record.messageKind ?? 'none')
    const flush = String(record.flushReason)
    kindCounts[messageKind] = (kindCounts[messageKind] ?? 0) + 1
    flushReasons[flush] = (flushReasons[flush] ?? 0) + 1
    if (record.replay === true) replayRecordsByFlush[flush] = (replayRecordsByFlush[flush] ?? 0) + 1
    const stream = `${record.sessionId}\u0000${record.streamEpoch}`
    if (record.replay !== true && record.deliveryAttempt === 1) {
      streamFrameCounts.set(stream, (streamFrameCounts.get(stream) ?? 0) + 1)
      if (messageKind !== 'stream_event' && typeof record.sequence === 'number') {
        const list = finishedSequences.get(stream) ?? []
        list.push(record.sequence)
        finishedSequences.set(stream, list)
      }
    }
  })
}
// Sequences between consecutive finished messages, and how many finished
// messages fit in the trace ring's 2,048-sequence window, per stream.
const spacing: number[] = []
const finishedWithinRing: number[] = []
for (const list of finishedSequences.values()) {
  const sorted = [...new Set(list)].sort((a, b) => a - b)
  for (let i = 1; i < sorted.length; i++) spacing.push(sorted[i]! - sorted[i - 1]!)
  const top = sorted.at(-1)
  if (top !== undefined && top > 2_048) finishedWithinRing.push(sorted.filter(s => s > top - 2_048).length)
}

// ── Transcript caches: real restore sizes, pictures, read cost ─────────────────
type CacheStats = { bytes: number; frames: number; messages: number; previews: number; parseMs: number }
const caches: CacheStats[] = []
const assistantTexts: string[] = []
for (const dirName of ['transcript-cache-v2', 'transcript-cache']) {
  const dir = join(desktop, dirName)
  let names: string[] = []
  try { names = readdirSync(dir).filter(name => name.endsWith('.json')) } catch { continue }
  for (const name of names) {
    const path = join(dir, name)
    const start = performance.now()
    let parsed: { frames?: unknown[] }
    try { parsed = JSON.parse(readFileSync(path, 'utf8')) } catch { continue }
    const parseMs = performance.now() - start
    const frames = Array.isArray(parsed.frames) ? parsed.frames as Record<string, any>[] : []
    let messages = 0
    let previews = 0
    for (const frame of frames) {
      if (frame?.kind === 'generated-image-preview') previews++
      const message = frame?.kind === 'event' && frame.event?.type === 'message' ? frame.event.message : null
      if (!message) continue
      messages++
      if (dirName === 'transcript-cache-v2' && message.type === 'assistant' && Array.isArray(message.message?.content)) {
        for (const block of message.message.content) if (block?.type === 'text' && typeof block.text === 'string') assistantTexts.push(block.text)
      }
    }
    caches.push({ bytes: statSync(path).size, frames: frames.length, messages, previews, parseMs })
  }
}

// ── Markdown: real finished replies streamed through the production planner ───
// Piece boundaries are synthetic (provider deltas are not stored); the text,
// structure and length are real.
function plan(cache: MarkdownPlanCache, source: string): number {
  const start = performance.now()
  planMarkdownLeaves('perf-real', source, {
    rehypePlugins: TRANSCRIPT_REHYPE_PLUGINS, allowPlainTextAppend: true, math: true, recognizeCallouts: true, cache,
  })
  return performance.now() - start
}
const textLengths = assistantTexts.map(text => text.length)
const LONG = 2_000
const sampleSize = config.smoke ? 2 : 20
const longTexts = assistantTexts.filter(text => text.length >= LONG).sort((a, b) => b.length - a.length)
// Spread the sample across the long-reply population instead of taking only the longest.
const sample = Array.from({ length: Math.min(sampleSize, longTexts.length) }, (_, i) =>
  longTexts[Math.floor((i * longTexts.length) / Math.min(sampleSize, longTexts.length))]!)
const markdown: Record<string, unknown> = {}
for (const wordsPerPiece of [1, 4]) {
  const times: number[] = []
  for (const text of sample) {
    const cache = createMarkdownPlanCache()
    let source = ''
    for (const piece of streamPieces(text, wordsPerPiece)) {
      source += piece
      times.push(plan(cache, source))
    }
  }
  markdown[`${wordsPerPiece}-word-pieces`] = {
    updates: times.length,
    updatesByPath: { unattributed: times.length },
    pathAttribution: 'unavailable: planner does not expose transform-path execution',
    perUpdateMs: distribution(times),
    pathAttributionNote: 'All updates are unclassified; tree identity is not a plugin-execution signal.',
    updatesOver16_7Ms: times.filter(t => t > 16.7).length,
  }
}

const finishedKinds = Object.entries(kindCounts).filter(([kind]) => kind !== 'stream_event').reduce((sum, [, n]) => sum + n, 0)
process.stdout.write(`${JSON.stringify({
  probe: 'real-data',
  runtime: `node ${process.version}`,
  operational: {
    files: operationalFiles.length,
    firstTimestamp,
    lastTimestamp,
    eventCounts,
    rendererGoneReasons: goneReasons,
    restoreMessageCount: distribution(restoreMessageCounts),
  },
  deliveryTrace: {
    files: traceFiles.length,
    bytes: traceBytes,
    firstTimestamp: traceFirst,
    lastTimestamp: traceLast,
    recordKinds,
    messageKinds: kindCounts,
    partialsPerFinishedRecord: round((kindCounts.stream_event ?? 0) / Math.max(1, finishedKinds), 2),
    flushReasons,
    replayRecordsByFlushReason: replayRecordsByFlush,
    streams: streamFrameCounts.size,
    sequencesBetweenFinishedMessages: distribution(spacing),
    finishedMessagesWithinLast2048Sequences: distribution(finishedWithinRing),
  },
  transcriptCaches: {
    files: caches.length,
    bytes: distribution(caches.map(c => c.bytes)),
    messagesPerCache: distribution(caches.map(c => c.messages)),
    framesPerCache: distribution(caches.map(c => c.frames)),
    cachesWithImagePreviews: caches.filter(c => c.previews > 0).length,
    readAndJsonParseMs: distribution(caches.map(c => c.parseMs)),
  },
  assistantText: {
    blocks: textLengths.length,
    characters: distribution(textLengths),
    blocksAtLeast2000: textLengths.filter(n => n >= 2_000).length,
    blocksAtLeast10000: textLengths.filter(n => n >= 10_000).length,
  },
  markdownStreamingEstimate: { sampledReplies: sample.length, sampleCharacters: distribution(sample.map(t => t.length)), ...markdown },
  notes: [
    'Aggregates only; no message text, identifiers or file paths are recorded.',
    'Logs cover only the retained window; delivery traces are bounded by size and age.',
    'Markdown piece boundaries are synthetic; provider deltas are not stored anywhere on disk.',
    'The planner API does not expose transformation-path execution; tree identity does not prove plugin execution.',
  ],
})}\n`)
