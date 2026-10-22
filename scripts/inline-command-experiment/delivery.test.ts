import { expect, test } from 'bun:test'
import { commandResultContext, deliverCompletedCommand } from './delivery.js'

const result = { runId: 'run-1', command: 'false', cwd: '/isolated/workspace', output: 'fixture output', exitCode: 1, status: 'completed' as const }

test('real QueryEngine automatically produces assistant frames with completed result in provider input', async () => {
  const evidence = await deliverCompletedCommand(result)
  expect(evidence.error).toBeUndefined()
  expect(evidence.accepted).toBe(true)
  expect(evidence.requests).toHaveLength(1)
  expect(JSON.stringify(evidence.requests)).toContain('fixture output')
  expect(evidence.frames.some(frame => frame.type === 'assistant')).toBe(true)
}, 40_000)

test('failed context persistence prevents provider dispatch', async () => {
  const evidence = await deliverCompletedCommand(result, { failPersistence: true })
  expect(evidence.error).toContain('Injected transcript write failure')
  expect(evidence.accepted).toBe(false)
  expect(evidence.requests).toHaveLength(0)
}, 40_000)

test('Agent Stop at accepted-input boundary suppresses provider dispatch', async () => {
  const evidence = await deliverCompletedCommand(result, { stopBeforeDispatch: true })
  expect(evidence.accepted).toBe(true)
  expect(evidence.requests).toHaveLength(0)
}, 40_000)

test('context preserves exact command and rejects oversized normalized output', () => {
  expect(commandResultContext(result)).toContain(JSON.stringify(result))
  expect(() => commandResultContext({ ...result, output: 'x'.repeat(32769) })).toThrow('budget')
})

test('busy result enters the next real tool-boundary request, not the in-flight request', async () => {
  const evidence = await deliverCompletedCommand(result, { busy: true })
  expect(evidence.error).toBeUndefined()
  expect(evidence.requests).toHaveLength(2)
  expect(JSON.stringify(evidence.requests[0])).not.toContain('fixture output')
  expect(JSON.stringify(evidence.requests[1])).toContain('fixture output')
  expect(evidence.frames.some(frame => frame.type === 'assistant')).toBe(true)
}, 40_000)

test('negative evidence: repeated delivery UUID does not deduplicate provider dispatch', async () => {
  const evidence = await deliverCompletedCommand(result, { repeat: true })
  expect(evidence.error).toBeUndefined()
  expect(evidence.requests).toHaveLength(2)
}, 40_000)

test('accepted context can remain without a provider dispatch or durable continuation receipt', async () => {
  const evidence = await deliverCompletedCommand(result, { crashAfterAcceptance: true })
  expect(evidence.accepted).toBe(true)
  expect(JSON.stringify(evidence.transcript)).toContain('fixture output')
  expect(evidence.requests).toHaveLength(0)
  expect(evidence.error).toContain('after context acceptance')
}, 40_000)

test('Agent Stop while a result is queued does not start another provider request', async () => {
  const evidence = await deliverCompletedCommand(result, { busy: true, stopBeforeDispatch: true })
  expect(evidence.requests).toHaveLength(1)
  expect(JSON.stringify(evidence.requests)).not.toContain('fixture output')
}, 40_000)

test('Codex routing builds real native input without account credentials or network', async () => {
  const evidence = await deliverCompletedCommand(result, { provider: 'codex' })
  expect(evidence.error).toBeUndefined()
  expect(evidence.codexRequests).toHaveLength(1)
  const body = evidence.codexRequests![0] as Record<string, unknown>
  expect(body.model).toBe('gpt-5.6-terra')
  expect(JSON.stringify(body.input)).toContain('fixture output')
  expect(JSON.stringify(body.input)).toContain('run-1')
  expect(body.instructions).toContain('Explain user command results.')
  expect(evidence.frames.some(frame => frame.type === 'assistant')).toBe(true)
}, 40_000)

for (const provider of ['claude', 'codex'] as const) {
test(`${provider}: SIGKILL after acceptance preserves context, but fresh-engine restore has no continuation and retry duplicates context`, async () => {
  const evidence = await deliverCompletedCommand(result, { recovery: true, provider })
  const recovery = evidence.recovery!
  expect(recovery.killedSignal).toBe('SIGKILL')
  expect(recovery.beforeKill.accepted).toBe(true)
  expect(recovery.beforeKill.requests).toHaveLength(0)
  expect(recovery.restored.requests).toHaveLength(0)
  expect(recovery.restored.frames).toHaveLength(0)
  expect(recovery.restored.transcript).toEqual(recovery.beforeKill.transcript)
  expect(JSON.stringify(recovery.restored.transcript)).toContain('fixture output')
  expect(recovery.retried.error).toBeUndefined()
  expect(recovery.retried.requests).toHaveLength(1)
  expect(recovery.retried.transcript.filter((message: any) => message.uuid === '22222222-2222-4222-8222-222222222222')).toHaveLength(2)
  const outbound = provider === 'codex' ? recovery.retried.codexRequests : recovery.retried.requests
  expect(JSON.stringify(outbound).split('fixture output').length - 1).toBe(2)
}, 100_000)
}

test('busy Codex routing places queued result only in the next native request', async () => {
  const evidence = await deliverCompletedCommand(result, { provider: 'codex', busy: true })
  expect(evidence.error).toBeUndefined()
  expect(evidence.codexRequests).toHaveLength(2)
  expect(JSON.stringify(evidence.codexRequests![0])).not.toContain('fixture output')
  expect(JSON.stringify(evidence.codexRequests![1])).toContain('fixture output')
}, 40_000)
