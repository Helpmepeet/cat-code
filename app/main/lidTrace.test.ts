import { expect, test } from 'bun:test'
import { createOperationalRecord, type OperationalEvent, type OperationalFields } from '../shared/operationalLog.js'
import type { LidModeView } from '../shared/lidClosed.js'
import type { LidNativeReply } from './lidClosedNative.js'
import { LidTrace } from './lidTrace.js'

type Line = { event: OperationalEvent; level: string; fields: OperationalFields; appSessionId?: string }

function harness() {
  let clock = 0
  const lines: Line[] = []
  const trace = new LidTrace((event, level, fields, appSessionId) => {
    // The real sink drops a record whose fields fall outside the event's
    // vocabulary, so every line must survive the production validator.
    const record = createOperationalRecord({ event, level, process: 'main', fields, ...(appSessionId ? { appSessionId } : {}) },
      { launchId: 'launch', processInstanceId: 'instance' })
    lines.push({ event, level, fields: record.fields, appSessionId: record.appSessionId })
  }, () => clock)
  const view = (patch: Partial<LidModeView>): LidModeView => ({
    phase: 'off', mode: null, allowance: 0, remainingSeconds: 0, workAvailable: false, activeSessions: 0,
    activeSubagents: 0, waitingForApproval: false, installed: true, sleepRequested: false, ...patch,
  })
  const advance = (ms: number) => { clock += ms }
  return { trace, lines, view, advance, events: () => lines.map(line => line.event) }
}

const reply = (record: Record<string, unknown>, ok = true): LidNativeReply => ({
  ok, snapshot: { record: { phase: 'active', began: 100, deadline: 1900, allowance: 1800, needsRestore: true,
    sleepRequested: false, sleepRequestAttempted: false, ...record } as never,
  safety: { thermal: 'nominal' }, remainingSeconds: 0, hardwareQualified: true },
})

test('a helper-ended run writes the heartbeats that preceded it', () => {
  const h = harness()
  // The owner's timer fires every second whether or not a run is active.
  h.trace.tick('run')
  h.trace.view(h.view({ phase: 'starting', mode: 'timed', allowance: 30 }))
  h.trace.view(h.view({ phase: 'active', mode: 'timed', allowance: 30 }))
  h.advance(1000)
  for (let index = 0; index < 3; index++) {
    h.trace.tick('run')
    h.advance(12); h.trace.command('pulse', 0, 12, 'ok', reply({}))
    h.advance(988)
  }
  // The heartbeat stalls in the bridge; the next fire is skipped behind it.
  h.trace.tick('run')
  h.advance(1000); h.trace.tick('skip-ticking')
  h.advance(1000); h.trace.command('pulse', 0, 2000, 'timeout')
  h.trace.bridge('closing', { reason: 'timeout', pid: 42 })
  h.trace.failure('tick', new Error('Helper unavailable'))
  h.trace.command('stop', 0, 30, 'refused', { ...reply({ phase: 'ended', reason: 'supervision-lost', needsRestore: false,
    clientPulse: 103.5, helperPulse: 109.2 }, false), error: 'lease-not-active' })
  h.trace.view(h.view({ phase: 'ended', mode: 'timed', reason: 'supervision-lost' }))

  const recorder = h.lines.find(line => line.event === 'lid.flight_recorder')!
  expect(recorder.fields.reason).toBe('supervision-lost')
  expect(recorder.fields.samples).toBe('1000+12o 1000+12o 1000+12o 1000+2000t 1000k')
  const stop = h.lines.find(line => line.event === 'lid.native.command' && line.fields.kind === 'stop')!
  expect(stop.fields).toMatchObject({ outcome: 'refused', code: 'lease-not-active', reason: 'supervision-lost', gapMs: 5700, ageMs: 9200 })
  expect(h.lines.find(line => line.event === 'lid.native.command' && line.fields.kind === 'pulse')!.fields.outcome).toBe('timeout')
  expect(h.lines.find(line => line.event === 'lid.bridge.changed')!.level).toBe('warn')
  expect(h.lines.find(line => line.event === 'lid.failure')!.fields).toMatchObject({ reason: 'tick', error: 'Helper unavailable' })
  const summary = h.lines.find(line => line.event === 'lid.heartbeat.summary')!
  expect(summary.fields).toMatchObject({ count: 3, missed: 1, skipped: 1, gapMs: 1000 })
  expect(h.events().filter(event => event === 'lid.mode.changed')).toHaveLength(3)
})

test('healthy heartbeats stay out of the log and a normal ending writes no recorder', () => {
  const h = harness()
  h.trace.view(h.view({ phase: 'active', mode: 'timed', allowance: 15 }))
  for (let index = 0; index < 20; index++) {
    h.advance(1000); h.trace.tick('run')
    h.advance(8); h.trace.command('pulse', 0, 8, 'ok', reply({}))
    h.trace.view(h.view({ phase: 'active', mode: 'timed', allowance: 15, remainingSeconds: 900 - index }))
  }
  h.advance(1000); h.trace.tick('run')
  h.advance(700); h.trace.command('pulse', 0, 700, 'ok', reply({}))
  h.trace.view(h.view({ phase: 'ended', mode: 'timed', reason: 'expired' }))

  expect(h.events()).toEqual(['lid.mode.changed', 'lid.native.command', 'lid.mode.changed', 'lid.heartbeat.summary'])
  expect(h.lines[1]!.fields).toMatchObject({ kind: 'pulse', outcome: 'ok', durationMs: 700 })
})

test('work supervision loss names the stale session only during a run', () => {
  const h = harness()
  const loss = { reason: 'stale-session' as const, sessionId: '0ca9312d-0000-4000-8000-000000000000', ageMs: 5012, status: 'ready', awaitingReply: true, sessions: 4 }
  h.trace.workLost(loss)
  expect(h.lines).toHaveLength(0)
  h.trace.view(h.view({ phase: 'active', mode: 'work', activeSessions: 2 }))
  h.trace.workLost(loss)
  const line = h.lines.find(item => item.event === 'lid.work.lost')!
  expect(line.appSessionId).toBe(loss.sessionId)
  expect(line.fields).toMatchObject({ reason: 'stale-session', ageMs: 5012, phase: 'ready', outcome: 'awaiting-reply', sessions: 4 })
  h.trace.view(h.view({ phase: 'off', mode: null }))
})

test('repeated failures are bounded per minute and counted', () => {
  const h = harness()
  h.trace.view(h.view({ phase: 'unresolved', error: 'Normal sleep has not been restored. Retry recovery.' }))
  const before = h.lines.length
  for (let index = 0; index < 100; index++) h.trace.command('status', 0, 5, 'unavailable')
  expect(h.lines.length - before).toBe(30)
  h.advance(60_001)
  h.trace.command('status', 0, 5, 'unavailable')
  expect(h.lines.length - before).toBe(31)
})
