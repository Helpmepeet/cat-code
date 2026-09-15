import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOperationalLogSink } from './operationalLogSink.js'

test('operational sink creates private JSONL artifacts and rotates bounded files', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-operational-log-'))
  const sink = createOperationalLogSink({ configDir: root, maxFileBytes: 120, maxFiles: 2 })
  sink.write({ level: 'info', event: 'app.start', process: 'main', fields: { version: 'test' } })
  sink.write({ level: 'info', event: 'app.ready', process: 'main', fields: { durationMs: 1 } })
  sink.flushFatal({ level: 'fatal', event: 'app.fatal', process: 'main', fields: { reason: '/private/secret' } })
  sink.close()
  const dir = sink.getDirectory()
  expect(statSync(dir).mode & 0o777).toBe(0o700)
  const files = readdirSync(dir)
  expect(files.length).toBeGreaterThan(0)
  expect(files).toContain('latest-operational')
  for (const name of files.filter(name => name.endsWith('.jsonl'))) {
    expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600)
  }
})

test('operational sink drops malformed producer input without throwing', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-operational-log-malformed-'))
  const sink = createOperationalLogSink({ configDir: root })
  expect(() => sink.write({
    level: 'info',
    event: 'app.start',
    process: 'main',
    fields: { reason: 'not an app.start field' },
  } as never)).not.toThrow()
  sink.close()
})

test('operational sink repairs permissions and enforces age retention without deleting active output', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-operational-log-retention-'))
  const directory = join(root, 'logs')
  mkdirSync(directory, { mode: 0o755 })
  const old = join(directory, 'operational-old-1.jsonl')
  writeFileSync(old, '{}\n', { mode: 0o644 })
  chmodSync(old, 0o644)
  const past = new Date(Date.now() - 10_000)
  utimesSync(old, past, past)
  const sink = createOperationalLogSink({ configDir: root, maxAgeMs: 1 })
  sink.write({ level: 'info', event: 'app.start', process: 'main', fields: { platform: 'test' } })
  sink.close()
  expect(statSync(directory).mode & 0o777).toBe(0o700)
  expect(existsSync(old)).toBe(false)
  expect(readdirSync(directory).some(name => name.startsWith('operational-'))).toBe(true)
})

// PEER-SESSIONS §10 promises one line per routed peer message, and the rate
// dedupe keys on `event:appSessionId:reason`. `peer.message.routed` has no
// `reason` field and its `appSessionId` is always the SENDER's by design
// (`peerRequestPlane.ts`), so every message a session sends inside one second
// collides on all three parts. The fan-out turn is exactly the one worth
// reconstructing, and its second message vanished.
test('every routed peer message from one sender is recorded, not deduped as a repeat', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-operational-log-peer-'))
  let clock = Date.parse('2026-09-04T00:00:00.000Z')
  const sink = createOperationalLogSink({
    configDir: root,
    now: () => new Date(clock),
  })
  sink.write({
    level: 'info',
    event: 'peer.message.routed',
    process: 'main',
    appSessionId: 'app-alex',
    fields: { from: 'Alex', to: 'Bear', kind: 'request', messageId: 'm-1', outcome: 'queued_live' },
  })
  clock += 120
  sink.write({
    level: 'info',
    event: 'peer.message.routed',
    process: 'main',
    appSessionId: 'app-alex',
    fields: { from: 'Alex', to: 'Cedar', kind: 'request', messageId: 'm-2', outcome: 'woke_session' },
  })
  sink.close()

  const lines = readdirSync(sink.getDirectory())
    .filter(name => name.endsWith('.jsonl'))
    .flatMap(name => readFileSync(join(sink.getDirectory(), name), 'utf8').split('\n'))
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as { event: string; fields: Record<string, unknown> })
  const routed = lines.filter(record => record.event === 'peer.message.routed')

  expect(routed.map(record => record.fields.messageId)).toEqual(['m-1', 'm-2'])
  expect(routed.map(record => record.fields.to)).toEqual(['Bear', 'Cedar'])
  expect(routed.map(record => record.fields.outcome)).toEqual(['queued_live', 'woke_session'])
  expect(lines.some(record => record.event === 'log.suppressed')).toBe(false)
})
