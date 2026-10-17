import { expect, test } from 'bun:test'
import { createWorkspaceJumpTiming } from './workspaceJumpTiming.js'
import { createOperationalRecord, parseOperationalRecord, type OperationalFields, type OperationalRecordInput } from './operationalLog.js'

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
    fields: { phase: 'resume', outcome: 'completed', durationMs: 1, operationId: 'operation', generation: 'generation' } }
  const context = { launchId: 'launch', processInstanceId: 'instance' }
  expect(createOperationalRecord(input, context).fields).toEqual(input.fields!)
  expect(parseOperationalRecord(createOperationalRecord(input, context))?.fields).toEqual(input.fields!)
  const changes: OperationalFields[] = [{ phase: 'arbitrary text' }, { outcome: 'prompt' }, { prompt: 'secret' }, { operationId: '/private/path' },
    { generation: 'contains spaces' }, { durationMs: -1 }, { durationMs: Infinity }]
  for (const change of changes) {
    expect(() => createOperationalRecord({ ...input, fields: { ...input.fields, ...change } }, context)).toThrow()
  }
})
