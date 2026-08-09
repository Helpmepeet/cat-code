import { expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mintDeliveryTrace } from '../shared/deliveryTrace.js'
import { createDeliveryTraceSink } from './deliveryTraceSink.js'

test('delivery trace persists metadata-only stages under private permissions', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-trace-'))
  const sink = createDeliveryTraceSink({ configDir: root, launchId: 'launch' })
  const trace = mintDeliveryTrace(1, 'stream')
  sink.mark({ sessionId: 'session', trace, stage: 'engine.produced' })
  sink.mark({ sessionId: 'session', trace, stage: 'main.ipc.sent' })
  expect(sink.accepts('session', 'stream', 1, 'doc', 1)).toBe(true)
  expect(sink.summary('session')).toMatchObject({
    produced: 1,
    ipcSent: 1,
    preloadReceived: 0,
    applied: 0,
    committed: 0,
    nextExpected: 2,
  })
  sink.close()
  const dir = join(root, 'logs')
  expect(statSync(dir).mode & 0o777).toBe(0o700)
  const traceFile = readdirSync(dir).find(name => name.startsWith('delivery-trace-'))
  expect(traceFile).toBeDefined()
  expect(readFileSync(join(dir, traceFile as string), 'utf8')).not.toContain('event')
  expect(readdirSync(dir)).toContain('latest-delivery')
})

test('delivery trace records sequence gaps and preserves every stage record', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-trace-anomaly-'))
  const sink = createDeliveryTraceSink({ configDir: root, launchId: 'launch' })
  sink.mark({ sessionId: 'session', trace: mintDeliveryTrace(1, 'stream'), stage: 'engine.produced' })
  sink.mark({ sessionId: 'session', trace: mintDeliveryTrace(3, 'stream'), stage: 'engine.produced' })
  sink.mark({ sessionId: 'session', trace: mintDeliveryTrace(3, 'stream'), stage: 'engine.produced' })
  sink.close()

  const file = readdirSync(join(root, 'logs')).find(name => name.startsWith('delivery-trace-'))!
  const text = readFileSync(join(root, 'logs', file), 'utf8')
  expect(text).toContain('trace.sequence.gap')
  expect(text).toContain('trace.sequence.duplicate')
  // Later observations cannot advance a contiguous source watermark over the
  // missing second sequence.
  expect(sink.summary('session')).toMatchObject({ produced: 1, nextExpected: 2 })
})

test('contiguous acknowledgements expose an earlier missing frame despite a later complete frame', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-trace-contiguous-'))
  const sink = createDeliveryTraceSink({ configDir: root, launchId: 'launch' })
  const first = mintDeliveryTrace(1, 'stream')
  const second = mintDeliveryTrace(2, 'stream')
  for (const stage of ['engine.produced', 'sidecar.socket.sent', 'host.received', 'main.ipc.sent'] as const) sink.mark({ sessionId: 'session', trace: first, stage })
  for (const stage of ['engine.produced', 'sidecar.socket.sent', 'host.received', 'main.ipc.sent', 'preload.received', 'renderer.state.applied', 'renderer.ui.committed'] as const) sink.mark({ sessionId: 'session', trace: second, stage })
  expect(sink.summary('session')).toMatchObject({ produced: 2, ipcSent: 2, preloadReceived: 0, applied: 0, committed: 0 })
  expect(sink.stuckSessionSummaries()[0]?.firstMissingStage).toBe('preload.received')
  sink.close()
})

test('delivery acknowledgement lookup cannot cross a recreated stream epoch', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-trace-epoch-'))
  const sink = createDeliveryTraceSink({ configDir: root, launchId: 'launch' })
  const first = mintDeliveryTrace(1, 'old-stream')
  const second = mintDeliveryTrace(1, 'new-stream')
  sink.mark({ sessionId: 'session', trace: first, stage: 'engine.produced' })
  sink.mark({ sessionId: 'session', trace: second, stage: 'engine.produced' })
  expect(sink.traceFor('session', 'old-stream', 1)?.traceId).toBe(first.traceId)
  expect(sink.traceFor('session', 'new-stream', 1)?.traceId).toBe(second.traceId)
  expect(sink.accepts('session', 'unknown-stream', 1, 'doc', 1)).toBe(false)
  sink.close()
})
