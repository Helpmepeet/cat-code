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
