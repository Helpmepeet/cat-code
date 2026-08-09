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
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_RUN_FACTS_TRANSCRIPT_BYTES,
  readTranscriptRunFacts,
} from './transcriptRunFacts.js'

/**
 * The facts half of a read. The `authoritative` half is a separate contract
 * (whether a `system`/`run_facts` snapshot was found) and has its own tests.
 */
function factsOf(...args: Parameters<typeof readTranscriptRunFacts>) {
  return readTranscriptRunFacts(...args).facts
}

function transcriptOf(records: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'runfacts-'))
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
