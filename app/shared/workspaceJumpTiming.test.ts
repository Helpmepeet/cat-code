import { expect, test } from 'bun:test'
import { createWorkspaceJumpTiming } from './workspaceJumpTiming.js'
import { createOperationalRecord, parseOperationalRecord, type OperationalFields, type OperationalRecordInput } from './operationalLog.js'
import { parseWorkerTimings } from './workerTiming.js'

test('timing spans use a local monotonic clock, finish once, and never affect work on sink failure', async () => {
  const records: OperationalRecordInput[] = []
  let clock = 100
  const timing = createWorkspaceJumpTiming(input => { records.push(input) }, () => clock)
  const end = timing.start({ appSessionId: 'session', operationId: 'operation', generation: 'generation' }, 'resume')
  clock = 150
  end(); end('failed')
  expect(records.map(record => record.fields)).toEqual([
    { phase: 'resume', outcome: 'started', durationMs: 0, operationId: 'operation', generation: 'generation' },
    { phase: 'resume', outcome: 'completed', durationMs: 50, operationId: 'operation', generation: 'generation' },
  ])
  const broken = createWorkspaceJumpTiming(() => { throw new Error('diagnostic sink unavailable') })
  expect(await broken.span({ appSessionId: 'session' }, 'resume', () => 42)).toBe(42)
  await expect(timing.span({ appSessionId: 'session' }, 'resume', () => { throw new Error('original') })).rejects.toThrow('original')
  expect(records.at(-1)?.fields?.outcome).toBe('failed')
})

test('operational timing rejects unbounded stages, outcomes, content fields, invalid identities and durations', () => {
  const input: OperationalRecordInput = { event: 'workspace.jump.timing', process: 'sidecar', level: 'info', appSessionId: 'session',
    fields: { phase: 'resume', outcome: 'completed', durationMs: 1, operationId: 'operation', generation: 'generation', invocationId: 'invocation' } }
  const context = { launchId: 'launch', processInstanceId: 'instance' }
  expect(createOperationalRecord(input, context).fields).toEqual(input.fields!)
  expect(parseOperationalRecord(createOperationalRecord(input, context))?.fields).toEqual(input.fields!)
  const changes: OperationalFields[] = [{ phase: 'arbitrary text' }, { outcome: 'prompt' }, { prompt: 'secret' }, { operationId: '/private/path' },
    { generation: 'contains spaces' }, { invocationId: '/private/path' }, { invocationId: 'contains spaces' },
    { invocationId: 'x'.repeat(1000) }, { invocationId: 5 }, { durationMs: -1 }, { durationMs: Infinity }]
  for (const change of changes) {
    expect(() => createOperationalRecord({ ...input, fields: { ...input.fields, ...change } }, context)).toThrow()
    expect(parseOperationalRecord({ ...createOperationalRecord(input, context), fields: { ...input.fields, ...change } })).toBeNull()
  }
})

test('private child timings accept only bounded metadata, never stderr content', () => {
  const valid = { phase: 'worker_bootstrap_imports', durationMs: 12, outcome: 'completed' } as const
  const line = (value: unknown) => `cat-worker-timing:${JSON.stringify(value)}`
  expect(parseWorkerTimings([line(valid), 'raw secret diagnostics', line({ ...valid, path: '/private' }),
    line({ ...valid, phase: 'prompt' }), line({ ...valid, durationMs: -1 }),
    line({ ...valid, durationMs: 600_001 }), line(null)].join('\n'))).toEqual([valid])
  expect(parseWorkerTimings(Array(100).fill(line(valid)).join('\n'))).toHaveLength(12)
})
