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

test('a dropped outbound frame carries its mechanism and kind, and nothing else', () => {
  const dropped = createOperationalRecord(
    {
      level: 'warn',
      event: 'frame.dropped',
      process: 'sidecar',
      fields: { reason: 'secret_key', frame: 'event' },
    },
    { launchId: 'launch', processInstanceId: 'process' },
  )
  expect(dropped.fields).toEqual({ reason: 'secret_key', frame: 'event' })
  expect(parseOperationalRecord(dropped)).not.toBeNull()
  // The refused frame's content is the one thing this record must never carry,
  // so the event owns no slot a payload could ride in.
  expect(() => createOperationalRecord(
    {
      level: 'warn',
      event: 'frame.dropped',
      process: 'sidecar',
      fields: { reason: 'secret_key', category: 'accessToken at message.content' },
    },
    { launchId: 'launch', processInstanceId: 'process' },
  )).toThrow('unsafe field category')
})

test('the macOS park has its own event so it cannot read as a hung shutdown', () => {
  const parked = createOperationalRecord(
    { level: 'info', event: 'app.parked.windowless', process: 'main' },
    { launchId: 'launch', processInstanceId: 'process' },
  )
  expect(parked.event).toBe('app.parked.windowless')
  expect(parked.fields).toEqual({})
  expect(parseOperationalRecord(parked)).not.toBeNull()
  // It describes a state, not a reason, and must not become a free-form slot:
  // `app.shutdown.started` owns `reason`, this owns nothing.
  expect(() => createOperationalRecord(
    { level: 'info', event: 'app.parked.windowless', process: 'main', fields: { reason: 'window-all-closed' } },
    { launchId: 'launch', processInstanceId: 'process' },
  )).toThrow('unsafe field reason')
})

test('renderer failure and incomplete coverage records keep closed metadata', () => {
  const unavailable = createOperationalRecord(
    {
      level: 'error',
      event: 'renderer.health.unavailable',
      process: 'main',
      fields: { missed: 6, elapsedMs: 35_000 },
    },
    { launchId: 'launch', processInstanceId: 'process' },
  )
  const incomplete = createOperationalRecord(
    {
      level: 'error',
      event: 'log.coverage.incomplete',
      process: 'main',
      fields: {
        source: 'sidecar',
        reason: 'stream_closed_without_flush_ack',
        expected: false,
      },
    },
    { launchId: 'launch', processInstanceId: 'process' },
  )

  expect(parseOperationalRecord(unavailable)).not.toBeNull()
  expect(parseOperationalRecord(incomplete)).not.toBeNull()
  expect(parseOperationalRecord({
    ...incomplete,
    fields: { ...incomplete.fields, category: 'not allowed' },
  })).toBeNull()
})

test('renderer health samples identify V8 heap usage explicitly', () => {
  const sample = createOperationalRecord(
    {
      level: 'info',
      event: 'renderer.health.sample',
      process: 'main',
      fields: { sessions: 2, eventLoopLagMs: 12, visible: false, jsHeapUsedBytes: 512_000_000 },
    },
    { launchId: 'launch', processInstanceId: 'process' },
  )
  expect(sample.fields.visible).toBe(false)
  expect(sample.fields.jsHeapUsedBytes).toBe(512_000_000)
  expect(parseOperationalRecord(sample)).not.toBeNull()

  // A renderer without the Chromium heap API reports no figure at all.
  const withoutHeap = createOperationalRecord(
    {
      level: 'info',
      event: 'renderer.health.sample',
      process: 'main',
      fields: { sessions: 0, eventLoopLagMs: 0, visible: true, jsHeapUsedBytes: null },
    },
    { launchId: 'launch', processInstanceId: 'process' },
  )
  expect(withoutHeap.fields.jsHeapUsedBytes).toBeNull()
  expect(parseOperationalRecord(withoutHeap)).not.toBeNull()

  // A missed probe has no payload to carry a heap figure, only the last known
  // visibility, so jsHeapUsedBytes stays out of that event's vocabulary.
  const missed = createOperationalRecord(
    {
      level: 'warn',
      event: 'renderer.health.missed',
      process: 'main',
      fields: { missed: 2, elapsedMs: 10_000, visible: false },
    },
    { launchId: 'launch', processInstanceId: 'process' },
  )
  expect(missed.fields.visible).toBe(false)
  expect(() => createOperationalRecord(
    {
      level: 'warn',
      event: 'renderer.health.missed',
      process: 'main',
      fields: { missed: 2, elapsedMs: 10_000, jsHeapUsedBytes: 512_000_000 },
    },
    { launchId: 'launch', processInstanceId: 'process' },
  )).toThrow('unsafe field jsHeapUsedBytes')
  expect(parseOperationalRecord({
    ...missed,
    fields: { ...missed.fields, jsHeapUsedBytes: 512_000_000 },
  })).toBeNull()
})

test('window records name the renderer process without opening a free-form slot', () => {
  const visibility = createOperationalRecord(
    {
      level: 'info',
      event: 'window.visibility.changed',
      process: 'main',
      fields: { visible: false, reason: 'minimize' },
    },
    { launchId: 'launch', processInstanceId: 'process' },
  )
  expect(visibility.fields).toEqual({ visible: false, reason: 'minimize' })
  expect(parseOperationalRecord(visibility)).not.toBeNull()

  // A visibility transition has no process identity to report, and a window
  // record has no prose slot: each event admits only what it can mean.
  expect(() => createOperationalRecord(
    {
      level: 'info',
      event: 'window.visibility.changed',
      process: 'main',
      fields: { visible: false, pid: 4242 },
    },
    { launchId: 'launch', processInstanceId: 'process' },
  )).toThrow('unsafe field pid')
  expect(() => createOperationalRecord(
    { level: 'info', event: 'window.created', process: 'main', fields: { pid: 4242, reason: 'why' } },
    { launchId: 'launch', processInstanceId: 'process' },
  )).toThrow('unsafe field reason')
  expect(parseOperationalRecord({
    ...visibility,
    fields: { ...visibility.fields, pid: 4242 },
  })).toBeNull()
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
