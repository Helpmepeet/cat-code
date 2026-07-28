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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTranscriptRunFacts } from './transcriptRunFacts.js'

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

test('every fact is read from the record shape the engine really writes', () => {
  const facts = readTranscriptRunFacts(
    transcriptOf([
      user('plan'),
      sendPath('high'),
      assistant('claude-sonnet-5'),
      user('acceptEdits'),
      sendPath('xhigh'),
      // The live donut's sum: input + both cache buckets.
      assistant('gpt-5.6-terra', {
        input_tokens: 1_163,
        cache_read_input_tokens: 186_368,
        cache_creation_input_tokens: 0,
      }),
    ]),
  )
  // Newest of each, independently.
  expect(facts.model).toBe('gpt-5.6-terra')
  expect(facts.permissionMode).toBe('acceptEdits')
  expect(facts.effort).toBe('xhigh')
  expect(facts.usedTokens).toBe(187_531)
})

test('an engine-internal mode survives, since it is what the session ran under', () => {
  const facts = readTranscriptRunFacts(transcriptOf([user('auto')]))
  expect(facts.permissionMode).toBe('auto')
})

/** Real transcripts open with all-zero usage rows; they say nothing about
 * context, and a zero would render an empty donut on a session that used it. */
test('all-zero usage is skipped in favour of a turn that really reported', () => {
  const facts = readTranscriptRunFacts(
    transcriptOf([
      assistant('m', { input_tokens: 900, cache_read_input_tokens: 100 }),
      assistant('m', {
        input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
    ]),
  )
  expect(facts.usedTokens).toBe(1_000)
})

test('effort is ignored on a system record of another subtype', () => {
  const facts = readTranscriptRunFacts(
    transcriptOf([
      sendPath('xhigh'),
      { type: 'system', subtype: 'turn_duration', effort: 'low' },
    ]),
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
  const facts = readTranscriptRunFacts(
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

test('with no resolver the window stays null, leaving the renderer its fallback', () => {
  const facts = readTranscriptRunFacts(transcriptOf([assistant('gpt-5.6-terra')]))
  expect(facts.model).toBe('gpt-5.6-terra')
  expect(facts.contextWindow).toBeNull()
})

test('a transcript with no model never asks for a window', () => {
  let asked = false
  const facts = readTranscriptRunFacts(transcriptOf([user('plan')]), () => {
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
  const facts = readTranscriptRunFacts(
    transcriptOf([assistant('gpt-5.6-terra', { input_tokens: 10 })]),
    resolve as (model: string) => number | null,
  )
  expect(facts.contextWindow).toBeNull()
  // The rest of the read is unaffected.
  expect(facts.model).toBe('gpt-5.6-terra')
  expect(facts.usedTokens).toBe(10)
})

test('a silent or unreadable transcript claims nothing, and never throws', () => {
  expect(readTranscriptRunFacts(transcriptOf([]))).toEqual({
    model: null,
    permissionMode: null,
    effort: null,
    usedTokens: null,
    contextWindow: null,
  })
  expect(readTranscriptRunFacts('/no/such/transcript.jsonl').model).toBeNull()
})

test('a corrupt line is skipped rather than failing the whole read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runfacts-bad-'))
  const file = join(dir, 't.jsonl')
  writeFileSync(file, `{not json\n${JSON.stringify(user('plan'))}\n`, 'utf8')
  expect(readTranscriptRunFacts(file).permissionMode).toBe('plan')
  rmSync(dir, { recursive: true, force: true })
})
