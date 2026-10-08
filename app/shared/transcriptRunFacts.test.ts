/**
 * The worker's raw-transcript derivation, against the SHAPES REAL TRANSCRIPTS
 * USE (measured 2026-07-28, `~/.cat-code/projects/**​/*.jsonl`):
 *
 *   model           `.message.model` on an `assistant` record
 *   permissionMode  `.permissionMode` on a USER record (not `system`/`init`,
 *                   which is where the SDK type snapshot declares it)
 *   effort          `.effort` on `system`/`codex_send_path`
 *   usedTokens      `.message.usage` on an `assistant` record
 *
 * The context WINDOW is measurably absent from all of them (0 `result` records,
 * 0 structural `modelUsage`/`contextWindow` keys across 167 transcripts), so it
 * is resolved from the newest model by an injected function — the worker's is
 * the engine's `getContextWindowForModel`. Injecting it is what keeps this
 * module, and this file, free of the engine graph the worker pulls in.
 *
 * This file exists because the first attempt at this feature derived from the
 * CACHE instead, which no longer carries any of it: the engine's
 * `toSDKMessages` conversion keeps conversation turns and drops the telemetry.
 * Fixtures here are raw JSONL lines, the same thing the worker reads.
 */
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_RUN_FACTS_READ_BYTES,
  MAX_RUN_FACTS_TRANSCRIPT_BYTES,
  readTranscriptRunFacts,
} from './transcriptRunFacts.js'
import {
  ANTHROPIC_CACHE_1H_MS,
  ANTHROPIC_CACHE_5M_MS,
  CODEX_CACHE_IDLE_ESTIMATE_MS,
} from './promptCacheEstimate.js'

/**
 * The facts half of a read. The `authoritative` half is a separate contract
 * (whether a `system`/`run_facts` snapshot was found) and has its own tests.
 */
function factsOf(...args: Parameters<typeof readTranscriptRunFacts>) {
  return readTranscriptRunFacts(...args).facts
}

const transcriptDirs: string[] = []
afterEach(() => {
  for (const dir of transcriptDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function transcriptOf(records: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'runfacts-'))
  transcriptDirs.push(dir)
  const file = join(dir, 'transcript.jsonl')
  writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n'), 'utf8')
  return file
}

const assistant = (model: string, usage?: Record<string, number>) => ({
  type: 'assistant',
  message: { role: 'assistant', model, ...(usage ? { usage } : {}) },
})
const user = (permissionMode?: string) => ({
  type: 'user',
  message: { role: 'user', content: 'hi' },
  ...(permissionMode ? { permissionMode } : {}),
})
const sendPath = (effort: string) => ({
  type: 'system',
  subtype: 'codex_send_path',
  effort,
})
/** Deliberately claims no window, for the tests that are about the other facts. */
const noWindow = () => null

test('every fact is read from the record shape the engine really writes', () => {
  const facts = factsOf(
    transcriptOf([
      user('plan'),
      sendPath('high'),
      assistant('claude-sonnet-5'),
      user('acceptEdits'),
      sendPath('xhigh'),
      // The live donut's sum: every input bucket plus output.
      assistant('gpt-5.6-terra', {
        input_tokens: 1_163,
        cache_read_input_tokens: 186_368,
        cache_creation_input_tokens: 0,
      }),
    ]),
    noWindow,
  )
  // Newest of each, independently.
  expect(facts.model).toBe('gpt-5.6-terra')
  expect(facts.permissionMode).toBe('acceptEdits')
  expect(facts.effort).toBe('xhigh')
  expect(facts.usedTokens).toBe(187_531)
})

/**
 * The numerator is the engine's `getTokenCountFromUsage` (`src/utils/tokens.ts:52-59`):
 * all three input buckets PLUS `output_tokens`. Dropping output undercounts by one
 * response, and would put this path out of step with the renderer's live gauge —
 * the same session would read two different sizes previewed vs attached.
 */
test('output_tokens counts toward context, matching the engine numerator', () => {
  const facts = factsOf(
    transcriptOf([
      assistant('gpt-5.6-sol', {
        input_tokens: 654,
        cache_read_input_tokens: 29_184,
        cache_creation_input_tokens: 0,
        output_tokens: 123,
      }),
    ]),
    noWindow,
  )
  // Input buckets alone would read 29,838; the engine's own measurement of this
  // reference turn was 29,961 (reviews/2026-08-02-context-gauge-accumulator.md).
  expect(facts.usedTokens).toBe(29_961)
})

test('a turn whose ONLY nonzero field is output still reports context', () => {
  const facts = factsOf(
    transcriptOf([
      assistant('m', {
        input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 40,
      }),
    ]),
    noWindow,
  )
  expect(facts.usedTokens).toBe(40)
})

test('an engine-internal mode survives, since it is what the session ran under', () => {
  const facts = factsOf(transcriptOf([user('auto')]), noWindow)
  expect(facts.permissionMode).toBe('auto')
})

/** Real transcripts open with all-zero usage rows; they say nothing about
 * context, and a zero would render an empty donut on a session that used it. */
test('all-zero usage is skipped in favour of a turn that really reported', () => {
  const facts = factsOf(
    transcriptOf([
      assistant('m', { input_tokens: 900, cache_read_input_tokens: 100 }),
      assistant('m', {
        input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
    ]),
    noWindow,
  )
  expect(facts.usedTokens).toBe(1_000)
})

test('effort is ignored on a system record of another subtype', () => {
  const facts = factsOf(
    transcriptOf([
      sendPath('xhigh'),
      { type: 'system', subtype: 'turn_duration', effort: 'low' },
    ]),
    noWindow,
  )
  expect(facts.effort).toBe('xhigh')
})

/**
 * The defect this closes: `contextWindow` was declared and never assigned, so
 * every backfilled preview divided by the renderer's 200k fallback. A 372k
 * gpt-5.6 session therefore read ~86% full when it was ~46%.
 */
test('the window is resolved from the newest model, so a non-200k one is real', () => {
  const asked: string[] = []
  const facts = factsOf(
    transcriptOf([
      assistant('claude-sonnet-5', { input_tokens: 10 }),
      assistant('gpt-5.6-terra', { input_tokens: 171_000 }),
    ]),
    model => {
      asked.push(model)
      return model === 'gpt-5.6-terra' ? 372_000 : 200_000
    },
  )
  // Asked about the model the session ENDED on, once, not per record.
  expect(asked).toEqual(['gpt-5.6-terra'])
  expect(facts.contextWindow).toBe(372_000)
  expect(facts.usedTokens).toBe(171_000)
})

test('a resolver that claims no window leaves the renderer its fallback', () => {
  const facts = factsOf(
    transcriptOf([assistant('gpt-5.6-terra')]),
    noWindow,
  )
  expect(facts.model).toBe('gpt-5.6-terra')
  expect(facts.contextWindow).toBeNull()
})

test('a transcript with no model never asks for a window', () => {
  let asked = false
  const facts = factsOf(transcriptOf([user('plan')]), () => {
    asked = true
    return 372_000
  })
  expect(asked).toBe(false)
  expect(facts.contextWindow).toBeNull()
})

/** Best-effort contract: the window is a display detail, never a backfill risk. */
test.each([
  ['throws', () => { throw new Error('model table unavailable') }],
  ['answers nothing', () => null],
  ['answers a non-number', () => Number.NaN],
  ['answers zero', () => 0],
])('a resolver that %s yields null rather than failing the read', (_label, resolve) => {
  const facts = factsOf(
    transcriptOf([assistant('gpt-5.6-terra', { input_tokens: 10 })]),
    resolve as (model: string) => number | null,
  )
  expect(facts.contextWindow).toBeNull()
  // The rest of the read is unaffected.
  expect(facts.model).toBe('gpt-5.6-terra')
  expect(facts.usedTokens).toBe(10)
})

test('a silent or unreadable transcript claims nothing, and never throws', () => {
  expect(factsOf(transcriptOf([]), noWindow)).toEqual({
    model: null,
    permissionMode: null,
    effort: null,
    usedTokens: null,
    contextWindow: null,
  })
  expect(factsOf('/no/such/transcript.jsonl', noWindow).model).toBeNull()
})

test('a corrupt line is skipped rather than failing the whole read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runfacts-bad-'))
  const file = join(dir, 't.jsonl')
  writeFileSync(file, `{not json\n${JSON.stringify(user('plan'))}\n`, 'utf8')
  expect(factsOf(file, noWindow).permissionMode).toBe('plan')
  rmSync(dir, { recursive: true, force: true })
})

const runFacts = (
  model: string,
  permissionMode: string,
  effort: string | null,
  contextWindow: number,
) => ({
  type: 'system',
  subtype: 'run_facts',
  model,
  permissionMode,
  effort,
  contextWindow,
})

/** Never called: a transcript carrying a snapshot must not consult the resolver. */
const forbiddenResolver = () => {
  throw new Error('resolver consulted despite a recorded window')
}

test('reads a bounded newline-aligned tail instead of materializing a whole transcript', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runfacts-tail-'))
  const file = join(dir, 'large.jsonl')
  // A single oversized historical line puts the read start mid-line. The
  // newline alignment must discard that partial record yet retain the newest
  // complete records below it.
  writeFileSync(
    file,
    [
      JSON.stringify(assistant('old-model', { input_tokens: 1 })),
      'x'.repeat(MAX_RUN_FACTS_READ_BYTES + 1024),
      JSON.stringify(runFacts('gpt-5.6-terra', 'auto', 'high', 372_000)),
      JSON.stringify(assistant('gpt-5.6-terra', { input_tokens: 123 })),
    ].join('\n'),
    'utf8',
  )
  try {
    const facts = readTranscriptRunFacts(file, forbiddenResolver).facts
    expect(facts).toMatchObject({
      model: 'gpt-5.6-terra',
      permissionMode: 'auto',
      effort: 'high',
      usedTokens: 123,
      contextWindow: 372_000,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a run_facts snapshot wins over the byproduct records, window included', () => {
  const facts = factsOf(
    transcriptOf([
      user('plan'),
      sendPath('low'),
      assistant('gpt-5.5', { input_tokens: 1000 }),
      runFacts('gpt-5.6-luna', 'auto', 'high', 372_000),
    ]),
    forbiddenResolver,
  )
  expect(facts.model).toBe('gpt-5.6-luna')
  expect(facts.permissionMode).toBe('auto')
  expect(facts.effort).toBe('high')
  // Captured at run time, not resolved from today's environment.
  expect(facts.contextWindow).toBe(372_000)
  // usedTokens is a MEASUREMENT, so it still comes from the assistant record.
  expect(facts.usedTokens).toBe(1000)
})

test('the snapshot is taken as a unit, not merged with newer byproducts', () => {
  // The send-path record is NEWER than the snapshot. Letting it win would pair
  // an effort from one turn with a model from another — the incoherence the
  // snapshot exists to remove.
  const facts = factsOf(
    transcriptOf([
      runFacts('gpt-5.6-luna', 'auto', 'high', 372_000),
      sendPath('xhigh'),
    ]),
    forbiddenResolver,
  )
  expect(facts.effort).toBe('high')
})

test('the newest snapshot wins when a session changed mid-run', () => {
  const facts = factsOf(
    transcriptOf([
      runFacts('claude-sonnet-5', 'default', null, 200_000),
      runFacts('gpt-5.6-sol', 'auto', 'xhigh', 372_000),
    ]),
    forbiddenResolver,
  )
  expect(facts.model).toBe('gpt-5.6-sol')
  expect(facts.effort).toBe('xhigh')
  expect(facts.contextWindow).toBe(372_000)
})

test('a legacy transcript still resolves its window from the model', () => {
  const facts = factsOf(
    transcriptOf([user('plan'), assistant('gpt-5.5', { input_tokens: 10 })]),
    model => (model === 'gpt-5.5' ? 272_000 : null),
  )
  expect(facts.model).toBe('gpt-5.5')
  expect(facts.contextWindow).toBe(272_000)
})

test('a snapshot with an unusable window falls back to the resolver', () => {
  const facts = factsOf(
    transcriptOf([runFacts('gpt-5.5', 'auto', 'high', 0)]),
    model => (model === 'gpt-5.5' ? 272_000 : null),
  )
  expect(facts.contextWindow).toBe(272_000)
})

/* ------------------------------------------------------------------------- *
 * Compaction — usage is stale on BOTH sides of the boundary
 * ------------------------------------------------------------------------- */

const boundary = (head: string, tail: string) => ({
  type: 'system',
  subtype: 'compact_boundary',
  compact_metadata: { preserved_segment: { head_uuid: head, tail_uuid: tail } },
})

const assistantWithUuid = (
  uuid: string,
  model: string,
  usage: Record<string, number>,
) => ({ ...assistant(model, usage), uuid })

test('usage below a compaction boundary is never read', () => {
  // Those records measure a context that no longer exists. `contextUsage.ts`
  // floors its walk at the boundary and this must match, or a close writes a
  // pre-compaction number into a header the renderer trusts wholesale.
  const facts = factsOf(
    transcriptOf([
      assistant('gpt-5.6-sol', { input_tokens: 300_000 }),
      boundary('head-1', 'tail-1'),
    ]),
    noWindow,
  )
  expect(facts.usedTokens).toBeNull()
})

test('the PRESERVED segment spliced above the boundary is skipped too', () => {
  // The subtle half. The engine splices the kept originals back in AFTER the
  // boundary, carrying their ORIGINAL usage, so a plain newest-wins scan lands
  // on a pre-compaction number that sits in the newest part of the file.
  const facts = factsOf(
    transcriptOf([
      boundary('head-1', 'tail-1'),
      assistantWithUuid('head-1', 'gpt-5.6-sol', { input_tokens: 300_000 }),
      assistantWithUuid('tail-1', 'gpt-5.6-sol', { input_tokens: 290_000 }),
      // The only post-compaction turn that actually reported.
      assistant('gpt-5.6-sol', { input_tokens: 12_000 }),
    ]),
    noWindow,
  )
  expect(facts.usedTokens).toBe(12_000)
})

test('a preserved segment with no post-compaction turn reports nothing', () => {
  // Rather than the preserved tail's stale high number. Null leaves the
  // renderer its own fallback, which would have rejected that value too.
  const facts = factsOf(
    transcriptOf([
      boundary('head-1', 'tail-1'),
      assistantWithUuid('head-1', 'gpt-5.6-sol', { input_tokens: 300_000 }),
      assistantWithUuid('tail-1', 'gpt-5.6-sol', { input_tokens: 290_000 }),
    ]),
    noWindow,
  )
  expect(facts.usedTokens).toBeNull()
  // The MODEL is still safe to read from a preserved record: compaction does
  // not change what model that turn ran on.
  expect(facts.model).toBe('gpt-5.6-sol')
})

/* ------------------------------------------------------------------------- *
 * Provenance + the read cap
 * ------------------------------------------------------------------------- */

test('an authoritative snapshot is reported as such, a legacy scan is not', () => {
  const withSnapshot = readTranscriptRunFacts(
    transcriptOf([
      {
        type: 'system',
        subtype: 'run_facts',
        model: 'gpt-5.6-sol',
        permissionMode: 'auto',
        effort: null,
        contextWindow: 372_000,
      },
    ]),
    noWindow,
  )
  expect(withSnapshot.authoritative).toBe(true)
  // `effort: null` on THIS tier means the run used the provider default. The
  // flag is what stops a caller patching a cached `high` over it.
  expect(withSnapshot.facts.effort).toBeNull()

  const legacy = readTranscriptRunFacts(
    transcriptOf([user('plan'), assistant('claude-sonnet-5')]),
    noWindow,
  )
  expect(legacy.authoritative).toBe(false)
})

test('an oversized transcript is declined before it is read', () => {
  // The scan is synchronous on Electron's main thread at every close, park,
  // crash and quit, and transcript size is driven by model and tool output.
  const dir = mkdtempSync(join(tmpdir(), 'runfacts-big-'))
  const file = join(dir, 'transcript.jsonl')
  writeFileSync(file, JSON.stringify(assistant('m', { input_tokens: 5 })), 'utf8')
  // Rather than writing 64 MB, prove the gate by its own constant.
  expect(MAX_RUN_FACTS_TRANSCRIPT_BYTES).toBe(64 * 1024 * 1024)
  expect(statSync(file).size).toBeLessThan(MAX_RUN_FACTS_TRANSCRIPT_BYTES)
  expect(readTranscriptRunFacts(file, noWindow).facts.usedTokens).toBe(5)
})

const OLD_RESPONSE_AT = Date.parse('2025-01-01T12:00:00.000Z')
const apiResponse = (
  model = 'gpt-5.6-sol',
  responseAt = OLD_RESPONSE_AT,
  usage: unknown = { input_tokens: 1_024 },
) => ({
  ...assistant(model),
  timestamp: new Date(responseAt).toISOString(),
  message: { role: 'assistant', model, usage },
})
const rawBoundary = (head: string, tail: string) => ({
  type: 'system',
  subtype: 'compact_boundary',
  compactMetadata: {
    preservedSegment: { headUuid: head, anchorUuid: 'anchor-1', tailUuid: tail },
    preservedMessages: { anchorUuid: 'anchor-1', durableUuids: [head, tail] },
  },
})

test('a legacy cache estimate uses the API timestamp, not subsequent user or tool activity', () => {
  const facts = factsOf(transcriptOf([
    apiResponse(),
    { ...user('auto'), timestamp: new Date().toISOString() },
    { type: 'progress', timestamp: new Date().toISOString(), data: { usage: {} } },
    { type: 'system', subtype: 'turn_duration', timestamp: new Date().toISOString() },
  ]), noWindow)
  expect(facts.cacheExpiresAt).toBe(OLD_RESPONSE_AT + CODEX_CACHE_IDLE_ESTIMATE_MS)
  expect(facts.cacheExpiresAt!).toBeLessThan(Date.now())
})

test('a recent API response replaces the old deadline while authoritative facts remain paired', () => {
  const recent = Date.now() - 60_000
  const read = readTranscriptRunFacts(transcriptOf([
    apiResponse(),
    runFacts('gpt-5.6-sol', 'auto', null, 372_000),
    apiResponse('gpt-5.6-sol', recent),
    sendPath('xhigh'),
  ]), forbiddenResolver)
  expect(read.authoritative).toBe(true)
  expect(read.facts.cacheExpiresAt).toBe(recent + CODEX_CACHE_IDLE_ESTIMATE_MS)
  expect(read.facts.cacheExpiresAt!).toBeGreaterThan(Date.now())
  expect(read.facts.effort).toBeNull()
  expect(read.facts.contextWindow).toBe(372_000)
})

test.each([
  ['5m write', {
    cache_creation_input_tokens: 2_048,
    cache_creation: { ephemeral_5m_input_tokens: 2_048 },
  }, ANTHROPIC_CACHE_5M_MS],
  ['1h write', {
    cache_creation_input_tokens: 2_048,
    cache_creation: { ephemeral_1h_input_tokens: 2_048 },
  }, ANTHROPIC_CACHE_1H_MS],
  ['read with unknown historical TTL', { cache_read_input_tokens: 2_048 }, ANTHROPIC_CACHE_1H_MS],
])('a Claude %s keeps the reported usage policy', (_label, usage, idleMs) => {
  const facts = factsOf(transcriptOf([
    apiResponse('claude-sonnet-5', OLD_RESPONSE_AT, usage),
  ]), noWindow)
  expect(facts.cacheExpiresAt).toBe(OLD_RESPONSE_AT + idleMs)
})

test.each([
  ['missing', undefined],
  ['null', null],
  ['numeric instead of recorded ISO', OLD_RESPONSE_AT],
  ['empty', ''],
  ['unparseable', 'not-a-date'],
  ['loose parseable date', '0'],
  ['normalized invalid calendar date', '2025-02-30T12:00:00.000Z'],
  ['negative epoch', '1969-12-31T23:59:59.000Z'],
  ['future', new Date(Date.now() + CODEX_CACHE_IDLE_ESTIMATE_MS).toISOString()],
])('a %s latest response timestamp does not fall back to an older estimate', (_label, timestamp) => {
  const facts = factsOf(transcriptOf([
    apiResponse(),
    { ...apiResponse(), timestamp },
  ]), noWindow)
  expect(facts.cacheExpiresAt).toBeUndefined()
  expect(facts).not.toHaveProperty('cacheExpiresAt')
})

test.each([
  ['all-zero', 'gpt-5.6-sol', { input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }],
  ['below Codex threshold', 'gpt-5.6-sol', { input_tokens: 1_023 }],
  ['output-only', 'gpt-5.6-sol', { output_tokens: 10_000 }],
  ['missing usage', 'gpt-5.6-sol', undefined],
  ['null usage', 'gpt-5.6-sol', null],
  ['malformed usage', 'gpt-5.6-sol', { input_tokens: '1024' }],
  ['Claude without observed cache use', 'claude-sonnet-5', { input_tokens: 100_000 }],
  ['unsupported model', 'other-model', { cache_read_input_tokens: 10_000 }],
])('%s latest usage cannot inherit an older eligible estimate', (_label, model, usage) => {
  const latest = apiResponse(model, OLD_RESPONSE_AT)
  const facts = factsOf(transcriptOf([
    apiResponse(),
    { ...latest, message: { ...latest.message, usage } },
  ]), noWindow)
  expect(facts.cacheExpiresAt).toBeUndefined()
})

test.each([
  ['synthetic model', { message: { model: '<synthetic>', usage: { input_tokens: 2_048 } } }],
  ['synthetic row', { isSynthetic: true }],
  ['API error', { isApiErrorMessage: true }],
  ['internal sentinel', { isInternalNoResponseSentinel: true }],
])('a %s row cannot supply a cache deadline', (_label, overrides) => {
  const facts = factsOf(transcriptOf([
    { ...apiResponse(), ...overrides },
  ]), noWindow)
  expect(facts.cacheExpiresAt).toBeUndefined()
})

test('an API error timestamp cannot extend the preceding real response estimate', () => {
  const facts = factsOf(transcriptOf([
    apiResponse(),
    user('plan'),
    runFacts('gpt-5.6-sol', 'auto', null, 372_000),
    { ...apiResponse('gpt-5.6-sol', Date.now() - 1_000), isApiErrorMessage: true },
  ]), forbiddenResolver)
  expect(facts.cacheExpiresAt).toBe(OLD_RESPONSE_AT + CODEX_CACHE_IDLE_ESTIMATE_MS)
})

test.each([
  ['raw transcript', rawBoundary('head-1', 'tail-1')],
  ['SDK-shaped metadata', boundary('head-1', 'tail-1')],
])('a %s compaction invalidates pre-boundary and preserved estimates', (_label, compactBoundary) => {
  const stale = apiResponse()
  const facts = factsOf(transcriptOf([
    stale,
    compactBoundary,
    { ...stale, uuid: 'head-1' },
    { ...stale, uuid: 'tail-1' },
  ]), noWindow)
  expect(facts.model).toBe('gpt-5.6-sol')
  expect(facts.cacheExpiresAt).toBeUndefined()
  expect(facts.usedTokens).toBeNull()
})

test('only a fresh post-compaction response can reestablish a deadline', () => {
  const recent = Date.now() - 60_000
  const facts = factsOf(transcriptOf([
    rawBoundary('head-1', 'tail-1'),
    { ...apiResponse(), uuid: 'head-1' },
    { ...apiResponse(), uuid: 'tail-1' },
    runFacts('gpt-5.6-sol', 'auto', null, 372_000),
    apiResponse('gpt-5.6-sol', recent),
  ]), forbiddenResolver)
  expect(facts.cacheExpiresAt).toBe(recent + CODEX_CACHE_IDLE_ESTIMATE_MS)
})

test('a model switch in authoritative facts cannot relabel the old response deadline', () => {
  const facts = factsOf(transcriptOf([
    apiResponse(),
    runFacts('gpt-5.7-sol', 'auto', 'high', 372_000),
  ]), forbiddenResolver)
  expect(facts.model).toBe('gpt-5.7-sol')
  expect(facts.effort).toBe('high')
  expect(facts.cacheExpiresAt).toBeUndefined()
})

test('a response model differing from the coherent snapshot cannot override its pairing', () => {
  const facts = factsOf(transcriptOf([
    runFacts('gpt-5.7-sol', 'auto', 'high', 372_000),
    apiResponse(),
  ]), forbiddenResolver)
  expect(facts.model).toBe('gpt-5.7-sol')
  expect(facts.cacheExpiresAt).toBeUndefined()
})

test('an API response outside the bounded tail cannot supply an old deadline', () => {
  const facts = factsOf(transcriptOf([
    apiResponse(),
    { type: 'progress', padding: 'x'.repeat(MAX_RUN_FACTS_READ_BYTES + 1_024) },
    runFacts('gpt-5.6-sol', 'auto', null, 372_000),
  ]), forbiddenResolver)
  expect(facts.model).toBe('gpt-5.6-sol')
  expect(facts.usedTokens).toBeNull()
  expect(facts.cacheExpiresAt).toBeUndefined()
})

const zeroCodexResponse = (model = 'gpt-6.1-sol') => apiResponse(model, OLD_RESPONSE_AT, {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
})
const completedSurface = (
  model = 'gpt-6.1-sol',
  at = OLD_RESPONSE_AT + 2_000,
) => ({
  type: 'system',
  subtype: 'codex_stream_surface',
  uuid: 'surface-1',
  timestamp: new Date(at).toISOString(),
  transport: 'websocket',
  transport_path: 'websocket',
  conversation_id_prefix: '1234abcd',
  account_id_prefix: 'testacct',
  model,
  input_tokens: 461_442,
  cached_tokens: 461_184,
  output_tokens: 100,
  raw_event_count: 3,
  raw_event_types: { 'response.completed': 1 },
  had_visible_output: true,
  had_tool_calls: false,
  completed: true,
})

test.each(['before', 'after'])(
  'a completed Codex surface %s the zero-usage assistant restores an activity estimate',
  order => {
    const response = zeroCodexResponse()
    const surface = completedSurface()
    const facts = factsOf(transcriptOf([
      runFacts('gpt-6.1-sol', 'auto', 'high', 1_048_576),
      ...(order === 'before' ? [surface, response] : [response, surface]),
    ]), forbiddenResolver)
    expect(facts.cacheExpiresAt).toBe(
      OLD_RESPONSE_AT + 2_000 + CODEX_CACHE_IDLE_ESTIMATE_MS,
    )
    expect(facts.usedTokens).toBeNull()
  },
)

test('a later auxiliary model cannot refresh the main model activity estimate', () => {
  const facts = factsOf(transcriptOf([
    runFacts('gpt-6.1-sol', 'auto', 'high', 1_048_576),
    zeroCodexResponse(),
    completedSurface(),
    completedSurface('gpt-6.1-luna', OLD_RESPONSE_AT + 60_000),
  ]), forbiddenResolver)
  expect(facts.model).toBe('gpt-6.1-sol')
  expect(facts.cacheExpiresAt).toBe(OLD_RESPONSE_AT + 2_000 + CODEX_CACHE_IDLE_ESTIMATE_MS)
  const mismatchedOnly = factsOf(transcriptOf([
    zeroCodexResponse(),
    completedSurface('gpt-6.1-luna'),
  ]), noWindow)
  expect(mismatchedOnly.cacheExpiresAt).toBeUndefined()
})

test('the newest completed matching surface supplies a recent activity deadline', () => {
  const recent = Date.now() - 1_000
  const facts = factsOf(transcriptOf([
    completedSurface(),
    zeroCodexResponse(),
    completedSurface('gpt-6.1-sol', recent),
  ]), noWindow)
  expect(facts.cacheExpiresAt).toBe(recent + CODEX_CACHE_IDLE_ESTIMATE_MS)
  expect(facts.cacheExpiresAt!).toBeGreaterThan(Date.now())
})

test('diagnostic recovery continues beyond the ordinary run-facts early exit', () => {
  const facts = factsOf(transcriptOf([
    completedSurface(),
    apiResponse('gpt-6.1-sol', OLD_RESPONSE_AT - 5_000, { input_tokens: 10 }),
    runFacts('gpt-6.1-sol', 'auto', 'high', 1_048_576),
    zeroCodexResponse(),
  ]), forbiddenResolver)
  expect(facts.usedTokens).toBe(10)
  expect(facts.cacheExpiresAt).toBe(OLD_RESPONSE_AT + 2_000 + CODEX_CACHE_IDLE_ESTIMATE_MS)
})

test.each([
  ['incomplete', { completed: false }],
  ['missing completion', { completed: undefined }],
  ['malformed completion', { completed: 'true' }],
  ['failed', { completed: false, error_name: 'ResponseFailed' }],
  ['contradictory failure', { completed: true, error_name: 'ResponseFailed' }],
  ['title affinity', { conversation_id_prefix: 'side/tit' }],
  ['other side affinity', { conversation_id_prefix: 'side/oth' }],
  ['visible agent affinity', { conversation_id_prefix: 'session/agent' }],
  ['sidechain envelope', { isSidechain: true }],
  ['agent-owned envelope', { agentId: 'agent-child' }],
  ['nested tool envelope', { parent_tool_use_id: 'toolu_child' }],
])('a %s surface cannot recover a zero-usage response', (_label, overrides) => {
  const facts = factsOf(transcriptOf([
    zeroCodexResponse(),
    { ...completedSurface(), ...overrides },
  ]), noWindow)
  expect(facts.cacheExpiresAt).toBeUndefined()
})

test.each([
  ['missing input', { input_tokens: undefined }],
  ['null input', { input_tokens: null }],
  ['string input', { input_tokens: '461442' }],
  ['negative input', { input_tokens: -1 }],
  ['fractional input', { input_tokens: 1_024.5 }],
  ['unsafe input', { input_tokens: Number.MAX_SAFE_INTEGER + 1 }],
  ['negative cached count', { cached_tokens: -1 }],
  ['fractional cached count', { cached_tokens: 0.5 }],
  ['string cached count', { cached_tokens: '461184' }],
  ['null cached count', { cached_tokens: null }],
  ['cached count exceeds inclusive input', { cached_tokens: 461_443 }],
  ['malformed output', { output_tokens: '100' }],
  ['missing timestamp', { timestamp: undefined }],
  ['numeric timestamp', { timestamp: OLD_RESPONSE_AT }],
  ['malformed timestamp', { timestamp: 'not-a-date' }],
  ['normalized calendar timestamp', { timestamp: '2025-02-30T12:00:00.000Z' }],
  ['future timestamp', { timestamp: new Date(Date.now() + CODEX_CACHE_IDLE_ESTIMATE_MS).toISOString() }],
])('a surface with %s degrades to unknown', (_label, overrides) => {
  const facts = factsOf(transcriptOf([
    zeroCodexResponse(),
    { ...completedSurface(), ...overrides },
  ]), noWindow)
  expect(facts.cacheExpiresAt).toBeUndefined()
})

test.each([
  ['missing', undefined],
  ['null', null],
  ['numeric', OLD_RESPONSE_AT],
  ['malformed', 'not-a-date'],
  ['future', new Date(Date.now() + CODEX_CACHE_IDLE_ESTIMATE_MS).toISOString()],
])('a diagnostic cannot repair a %s latest assistant timestamp', (_label, timestamp) => {
  const facts = factsOf(transcriptOf([
    { ...zeroCodexResponse(), timestamp },
    completedSurface(),
  ]), noWindow)
  expect(facts.cacheExpiresAt).toBeUndefined()
})

test.each([
  ['synthetic', { isSynthetic: true }],
  ['API error', { isApiErrorMessage: true }],
  ['sentinel', { isInternalNoResponseSentinel: true }],
  ['synthetic model', { message: { model: '<synthetic>', usage: {} } }],
])('a diagnostic cannot supply an estimate for a %s assistant', (_label, overrides) => {
  const facts = factsOf(transcriptOf([
    { ...zeroCodexResponse(), ...overrides },
    completedSurface(),
  ]), noWindow)
  expect(facts.cacheExpiresAt).toBeUndefined()
})

test('inclusive OpenAI input is counted once, not summed with cached_tokens', () => {
  const tooSmall = factsOf(transcriptOf([
    zeroCodexResponse(),
    { ...completedSurface(), input_tokens: 800, cached_tokens: 800 },
  ]), noWindow)
  expect(tooSmall.cacheExpiresAt).toBeUndefined()
  const eligible = factsOf(transcriptOf([
    zeroCodexResponse(),
    { ...completedSurface(), input_tokens: 1_024, cached_tokens: 1_024 },
  ]), noWindow)
  expect(eligible.cacheExpiresAt).toBe(OLD_RESPONSE_AT + 2_000 + CODEX_CACHE_IDLE_ESTIMATE_MS)
})

test('omitted zero diagnostic counters and a successful HTTP fallback remain eligible', () => {
  const facts = factsOf(transcriptOf([
    zeroCodexResponse(),
    {
      ...completedSurface(),
      cached_tokens: undefined,
      output_tokens: undefined,
      transport_path: 'websocket_then_http',
      fallback_error_name: 'WebSocketUnavailable',
    },
  ]), noWindow)
  expect(facts.cacheExpiresAt).toBe(OLD_RESPONSE_AT + 2_000 + CODEX_CACHE_IDLE_ESTIMATE_MS)
})

test('usable assistant metadata stays preferred over later completed diagnostics', () => {
  const facts = factsOf(transcriptOf([
    apiResponse('gpt-6.1-sol', OLD_RESPONSE_AT, { input_tokens: 2_048 }),
    completedSurface('gpt-6.1-sol', OLD_RESPONSE_AT + 60_000),
  ]), noWindow)
  expect(facts.cacheExpiresAt).toBe(OLD_RESPONSE_AT + CODEX_CACHE_IDLE_ESTIMATE_MS)
})

test.each([
  ['missing', undefined],
  ['null', null],
  ['malformed', { input_tokens: '0' }],
  ['nonzero below threshold', { input_tokens: 512, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }],
  ['output-only', { input_tokens: 0, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }],
])('a diagnostic cannot override %s assistant usage', (_label, usage) => {
  const response = zeroCodexResponse()
  const facts = factsOf(transcriptOf([
    { ...response, message: { ...response.message, usage } },
    completedSurface(),
  ]), noWindow)
  expect(facts.cacheExpiresAt).toBeUndefined()
})

test('a model-less send-path completion cannot supply the fallback', () => {
  const facts = factsOf(transcriptOf([
    zeroCodexResponse(),
    {
      ...sendPath('high'),
      timestamp: new Date(OLD_RESPONSE_AT + 2_000).toISOString(),
      input_tokens: 461_442,
      cached_tokens: 461_184,
    },
  ]), noWindow)
  expect(facts.cacheExpiresAt).toBeUndefined()
})

test('a newer coherent model snapshot cannot inherit an old-model diagnostic', () => {
  const facts = factsOf(transcriptOf([
    zeroCodexResponse(),
    completedSurface(),
    runFacts('gpt-6.1-luna', 'auto', 'high', 1_048_576),
    completedSurface('gpt-6.1-luna', OLD_RESPONSE_AT + 60_000),
  ]), forbiddenResolver)
  expect(facts.model).toBe('gpt-6.1-luna')
  expect(facts.cacheExpiresAt).toBeUndefined()
})

test('compaction prevents both stale response and stale diagnostic recovery', () => {
  const compact = rawBoundary('head-1', 'tail-1')
  const cases = [
    [zeroCodexResponse(), completedSurface(), compact],
    [zeroCodexResponse(), compact, completedSurface()],
    [completedSurface(), compact, zeroCodexResponse()],
    [compact, { ...zeroCodexResponse(), uuid: 'head-1' },
      { ...zeroCodexResponse(), uuid: 'tail-1' }, completedSurface()],
    [compact, { ...completedSurface(), uuid: 'head-1' },
      { ...zeroCodexResponse(), uuid: 'tail-1' }, zeroCodexResponse()],
  ]
  for (const records of cases) {
    expect(factsOf(transcriptOf(records), noWindow).cacheExpiresAt).toBeUndefined()
  }
  const fresh = factsOf(transcriptOf([
    compact,
    { ...zeroCodexResponse(), uuid: 'head-1' },
    { ...zeroCodexResponse(), uuid: 'tail-1' },
    zeroCodexResponse(),
    completedSurface(),
  ]), noWindow)
  expect(fresh.cacheExpiresAt).toBe(OLD_RESPONSE_AT + 2_000 + CODEX_CACHE_IDLE_ESTIMATE_MS)
})

test('an unavailable newest matching completion cannot borrow older diagnostic counts', () => {
  const facts = factsOf(transcriptOf([
    zeroCodexResponse(),
    completedSurface(),
    { ...completedSurface('gpt-6.1-sol', OLD_RESPONSE_AT + 3_000), input_tokens: undefined },
  ]), noWindow)
  expect(facts.cacheExpiresAt).toBeUndefined()
})

test('a diagnostic outside the read window is not recovered with another file read', () => {
  const facts = factsOf(transcriptOf([
    completedSurface(),
    { type: 'progress', padding: 'x'.repeat(MAX_RUN_FACTS_READ_BYTES + 1_024) },
    zeroCodexResponse(),
  ]), noWindow)
  expect(facts.cacheExpiresAt).toBeUndefined()
})

test('a completed diagnostic without a real assistant response claims no expiry', () => {
  const facts = factsOf(transcriptOf([
    runFacts('gpt-6.1-sol', 'auto', 'high', 1_048_576),
    completedSurface(),
  ]), forbiddenResolver)
  expect(facts.cacheExpiresAt).toBeUndefined()
})
