import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import type { Message } from '../types/message.js'
import {
  canonicalResumeJson,
  resumeProjectionV1,
  resumeProjectionSha256,
  resumeProjectionV2,
  resumeProjectionV2Sha256,
  verifyResumeProjectionV2,
} from './resumeCheckpoint.js'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function user(n: number, content: unknown = `input ${n}`): Message {
  return { type: 'user', uuid: uuid(n), timestamp: '2026-10-30T00:00:00.000Z',
    message: { role: 'user', content } } as Message
}
function assistant(n: number, content: unknown, id = `response-${n}`): Message {
  return { type: 'assistant', uuid: uuid(n), timestamp: '2026-10-30T00:00:00.000Z',
    message: { role: 'assistant', id, model: 'fixture', content,
      usage: { input_tokens: 4, output_tokens: 2 }, stop_reason: 'end_turn', stop_sequence: null } } as Message
}
const text = (n: number) => assistant(n, [{ type: 'text', text: `answer ${n}` }])
const call = (n: number) => assistant(n, [{ type: 'tool_use', id: `call-${n}`, name: 'Read', input: { file_path: 'fixture' } }])
const result = (n: number, callNumber: number) => user(n, [{ type: 'tool_result', tool_use_id: `call-${callNumber}`, content: 'completed content' }])
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

test('V1 remains an exact raw projection with the original envelope exclusions', () => {
  const row = { type: 'user', uuid: uuid(1), message: { role: 'user', content: 'hello' },
    origin: { kind: 'fixture' }, isMeta: true, sessionId: uuid(99), parentUuid: uuid(98), version: 'old' }
  const canonical = `[{"isMeta":true,"message":{"content":"hello","role":"user"},"origin":{"kind":"fixture"},"type":"user","uuid":"${uuid(1)}"}]`
  expect(canonicalResumeJson(resumeProjectionV1([row]))).toBe(canonical)
  expect(resumeProjectionSha256([row])).toBe(sha(canonical))
  const unfinished = call(2)
  expect(resumeProjectionV1([row, unfinished])).toHaveLength(2)
  expect(resumeProjectionV2([row as Message, unfinished])).toHaveLength(1)
})

test.each([
  ['unresolved tool trajectory', call(2)],
  ['orphan thinking', assistant(2, [{ type: 'thinking', thinking: 'unfinished', signature: 'signature' }])],
  ['whitespace assistant', assistant(2, [{ type: 'text', text: '\n  ' }])],
] as const)('V2 permits legitimate removal of %s without mutating either independent input', (_label, removed) => {
  const archived = freeze([user(1), removed, user(3), text(4)])
  const intended = freeze(structuredClone([archived[0]!, archived[2]!, archived[3]!]))
  const archivedBefore = canonicalResumeJson(archived)
  const intendedBefore = canonicalResumeJson(intended)
  const proof = verifyResumeProjectionV2(intended, archived)
  expect(proof).toEqual({ projectionSha256: resumeProjectionV2Sha256(intended), messageCount: 3 })
  expect(resumeProjectionV2(archived)).toEqual(resumeProjectionV1(intended))
  expect(canonicalResumeJson(archived)).toBe(archivedBefore)
  expect(canonicalResumeJson(intended)).toBe(intendedBefore)
  expect(verifyResumeProjectionV2(archived, structuredClone(archived))).toEqual(proof)
})

test('V2 preserves completed tools, matched thinking, partial tool trajectories and all metadata', () => {
  const thinking = assistant(2, [{ type: 'thinking', thinking: 'matched', signature: 'signature' }], 'shared-response')
  const answer = assistant(3, [{ type: 'text', text: 'visible' }], 'shared-response')
  const partial = assistant(4, [
    { type: 'tool_use', id: 'call-4', name: 'Read', input: {} },
    { type: 'tool_use', id: 'still-open', name: 'Read', input: {} },
  ])
  const messages = [user(1), thinking, answer, partial, result(5, 4), text(6)]
  expect(resumeProjectionV2(messages)).toEqual(resumeProjectionV1(messages))
  expect(verifyResumeProjectionV2(structuredClone(messages), messages).messageCount).toBe(6)
})

test('missing or changed engine-retained unfinished rows reject before filtering can conceal them', () => {
  const unfinished = call(2)
  const intended = [user(1), unfinished, user(3), text(4)]
  const missing = [intended[0]!, intended[2]!, intended[3]!]
  expect(resumeProjectionV2(intended)).toEqual(resumeProjectionV2(missing))
  expect(() => verifyResumeProjectionV2(intended, missing)).toThrow('Retained resume message differs')
  const changed = structuredClone(intended)
  const row = changed[1] as Extract<Message, { type: 'assistant' }>
  row.message.content = [{ type: 'tool_use', id: 'call-2', name: 'Read', input: { file_path: 'altered' } }]
  expect(resumeProjectionV2(intended)).toEqual(resumeProjectionV2(changed))
  expect(() => verifyResumeProjectionV2(intended, changed)).toThrow('Retained resume message differs')
})

test('missing completed tool results reject from either side', () => {
  const complete = [user(1), call(2), result(3, 2), text(4)]
  const missingResult = [complete[0]!, complete[1]!, complete[3]!]
  expect(() => verifyResumeProjectionV2(complete, missingResult)).toThrow('Retained resume message differs')
  expect(() => verifyResumeProjectionV2(missingResult, complete)).toThrow('projection V2 differs')
})

test('missing user input, changed content/provenance/final metadata and reordered rows reject', () => {
  const original = [user(1), text(2), user(3), text(4)]
  expect(() => verifyResumeProjectionV2(original, original.slice(1))).toThrow('Retained resume message differs')
  for (const alter of [
    (rows: Message[]) => { (rows[0] as Extract<Message, { type: 'user' }>).message.content = 'changed input' },
    (rows: Message[]) => { Object.assign(rows[0]!, { origin: { kind: 'remote', peer: 'changed' } }) },
    (rows: Message[]) => { (rows[1] as Extract<Message, { type: 'assistant' }>).message.usage.output_tokens++ },
    (rows: Message[]) => { (rows[1] as Extract<Message, { type: 'assistant' }>).message.stop_reason = 'tool_use' },
    (rows: Message[]) => { Object.assign(rows[0]!, { isMeta: true }) },
  ]) {
    const changed = structuredClone(original)
    alter(changed)
    expect(() => verifyResumeProjectionV2(original, changed)).toThrow('Retained resume message differs')
  }
  expect(() => verifyResumeProjectionV2(original, [original[2]!, original[1]!, original[0]!, original[3]!])).toThrow('order differs')
})

test('extra nonremovable archived rows reject rather than defining the intended digest', () => {
  const intended = [user(1), text(2)]
  for (const extra of [user(3), text(3), result(3, 99)]) {
    expect(() => verifyResumeProjectionV2(intended, [...intended, extra])).toThrow('projection V2 differs')
  }
})

test('V2 raw equality excludes only V1 storage envelope fields', () => {
  const intended = [user(1), text(2)]
  const archived = structuredClone(intended).map(row => ({ ...row, parentUuid: uuid(8), sessionId: uuid(9), cwd: '/fixture' }))
  expect(verifyResumeProjectionV2(intended, archived).projectionSha256).toBe(resumeProjectionV2Sha256(intended))
})

test('V2 rejects duplicate/invalid UUIDs and non-JSON proof content', () => {
  const row = user(1)
  expect(() => verifyResumeProjectionV2([row, row], [row])).toThrow('duplicate')
  expect(() => verifyResumeProjectionV2([row], [row, row])).toThrow('duplicate')
  expect(() => verifyResumeProjectionV2([{ ...row, uuid: 'not-a-uuid' } as Message], [row])).toThrow('UUID')
  expect(() => resumeProjectionV2([user(1, [undefined])])).toThrow('undefined array')
  expect(() => resumeProjectionV2([user(1, Number.NaN)])).toThrow('non-JSON')
})
