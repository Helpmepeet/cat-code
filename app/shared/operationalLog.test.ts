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
