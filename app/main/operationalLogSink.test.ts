import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
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
