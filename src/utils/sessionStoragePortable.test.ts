import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDisplayTranscriptTail } from './sessionStoragePortable.js'

let directory: string
let path: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'display-transcript-tail-'))
  path = join(directory, 'agent.jsonl')
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

const record = (uuid: string, text = '') => JSON.stringify({ uuid, text }) + '\n'

test('scans a long reachable suffix once and stops before unrelated history', async () => {
  const prefix = record('old', 'x'.repeat(32 * 1024))
  const lines = Array.from({ length: 850 }, (_, index) => record(`step-${index}`, 'é'.repeat(2400)))
  const suffix = lines.join('')
  writeFileSync(path, prefix + suffix)
  const parse = spyOn(JSON, 'parse')
  let result: Awaited<ReturnType<typeof readDisplayTranscriptTail>>
  try {
    result = await readDisplayTranscriptTail(path, 4 * 1024 * 1024, ['step-0'])
    // Each complete line, including lines straddling chunks, is parsed once.
    expect(parse.mock.calls.length).toBe(lines.length)
  } finally {
    parse.mockRestore()
  }
  expect(result!.buffer.toString()).toBe(suffix)
  expect(result!.truncated).toBe(true)
  expect(result!.bytesRead).toBeLessThanOrEqual(Buffer.byteLength(suffix) + 4096 + 1)
  expect(result!.bytesRead).toBeLessThanOrEqual(4 * 1024 * 1024)
})

test('preserves an aligned first record within the counted run-aware budget', async () => {
  const suffix = record('start', 'complete first record') + record('end')
  writeFileSync(path, record('old', 'x'.repeat(100)) + suffix)
  // The preceding newline probe is part of the allowance, not an extra read.
  const maxBytes = Buffer.byteLength(suffix) + 1
  const result = await readDisplayTranscriptTail(path, maxBytes, ['start'])
  expect(result.buffer.toString()).toBe(suffix)
  expect(result.bytesRead).toBe(maxBytes)
  expect(result.truncated).toBe(true)
})

test('does not treat a partial leading record as a complete requested start', async () => {
  const last = record('end')
  writeFileSync(path, record('start', 'x'.repeat(5000)) + last)
  const result = await readDisplayTranscriptTail(path, Buffer.byteLength(last) + 100, ['start'])
  expect(result.buffer.toString()).toBe(last)
  expect(result.bytesRead).toBeLessThanOrEqual(Buffer.byteLength(last) + 100)
})

test('retains a requested first record at the beginning of the file', async () => {
  const contents = record('start', 'x'.repeat(6000)) + record('end')
  writeFileSync(path, contents)
  const result = await readDisplayTranscriptTail(path, Buffer.byteLength(contents), ['start'])
  expect(result.buffer.toString()).toBe(contents)
  expect(result.bytesRead).toBe(Buffer.byteLength(contents))
  expect(result.truncated).toBe(false)
})
