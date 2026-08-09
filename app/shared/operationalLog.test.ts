import { expect, test } from 'bun:test'
import { createOperationalRecord, parseOperationalRecord, sanitizeOperationalText } from './operationalLog.js'

test('operational records redact paths, URL secrets, and token-shaped values', () => {
  const record = createOperationalRecord(
    {
      level: 'error',
      event: 'app.fatal',
      process: 'main',
      fields: { reason: 'failed at /Users/alice/project?token=sk_abcdefghijklmnopqrstuvwxyz' },
    },
    { launchId: 'launch', processInstanceId: 'process', now: () => new Date('2026-08-06T00:00:00Z') },
  )
  expect(record.fields.reason).not.toContain('/Users/alice')
  expect(record.fields.reason).not.toContain('sk_')
  expect(parseOperationalRecord({ ...record, fields: { apiKey: 'nope' } })).toBeNull()
  expect(parseOperationalRecord({ ...record, fields: { message: 'nope' } })).toBeNull()
  expect(parseOperationalRecord({ ...record, payload: 'nope' })).toBeNull()
})

test('operational events accept only their declared metadata fields', () => {
  const appStart = createOperationalRecord(
    {
      level: 'info',
      event: 'app.start',
      process: 'main',
      fields: { packaged: false, platform: 'darwin', arch: 'arm64' },
    },
    { launchId: 'launch', processInstanceId: 'process' },
  )
  expect(appStart.fields.platform).toBe('darwin')
  expect(() => createOperationalRecord(
    { level: 'info', event: 'app.start', process: 'main', fields: { reason: 'not valid for startup' } },
    { launchId: 'launch', processInstanceId: 'process' },
  )).toThrow('unsafe field reason')
  expect(parseOperationalRecord({ ...appStart, fields: { reason: 'not valid for startup' } })).toBeNull()
})

test('operational text removes every rooted path and URL path/query', () => {
  expect(sanitizeOperationalText('/var/db/private.txt C:\\Users\\alice\\secret https://user:pw@example.com/private/customer?a=1#x'))
    .not.toMatch(/var\/db|Users\\alice|private\/customer|user:pw|\?a=/)
})

test('operational text redacts a rooted path behind any delimiter, a non-http scheme, and an address', () => {
  // The path rule only anchored after whitespace or a quote, so a path behind
  // any other delimiter reached the log and the exported bundle intact.
  expect(sanitizeOperationalText('cwd=/Users/alice/private')).not.toContain('/Users/alice')
  expect(sanitizeOperationalText('path:/Users/alice/secret')).not.toContain('/Users/alice')
  // The URL rule matched http(s) only, so a file URL kept the whole home path.
  expect(sanitizeOperationalText('file:///Users/alice/private')).not.toContain('/Users/alice')
  expect(sanitizeOperationalText('reached alice@example.com')).not.toContain('alice@example.com')
  // A guard added so a rewritten URL's "//" is not read as a path also let a
  // double-slash share path through, which is still a rooted location.
  expect(sanitizeOperationalText('//server/share/private')).not.toContain('server/share')
  expect(sanitizeOperationalText('https://example.com')).toBe('https://example.com')
})

test('operational records reject a non-identifier in an identifier slot', () => {
  const record = createOperationalRecord(
    { level: 'info', event: 'diagnostic', process: 'sidecar', fields: { source: 'sidecar' } },
    { launchId: 'launch', processInstanceId: 'process' },
  )
  expect(parseOperationalRecord(record)).not.toBeNull()
  // These carried arbitrary strings, so a producer could route a path or an
  // address out through an id instead of a metadata field.
  expect(parseOperationalRecord({ ...record, launchId: '/Users/alice/private' })).toBeNull()
  expect(parseOperationalRecord({ ...record, processInstanceId: 'alice@example.com' })).toBeNull()
  expect(parseOperationalRecord({ ...record, appSessionId: '/var/db/private' })).toBeNull()
  expect(parseOperationalRecord({ ...record, engineSessionId: 'has spaces' })).toBeNull()
})

test('operational text leaves a relative segment alone', () => {
  // Widening the path rule must not start eating ordinary prose and counters.
  expect(sanitizeOperationalText('and/or read 12/34 frames')).toBe('and/or read 12/34 frames')
})
