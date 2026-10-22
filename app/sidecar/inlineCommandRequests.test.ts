import { expect, test } from 'bun:test'
import { InlineCommandRequests, inlineCommandMessageSchema } from './inlineCommandRequests.js'
import type { InlineCommandRun, InlineCommandSource } from '../shared/inlineCommand.js'

const source: InlineCommandSource = {
  engineSessionId: 'engine', messageUuid: 'message', contentBlockIndex: 0, fenceOrdinal: 0,
}

function run(index: number): InlineCommandRun {
  return { runId: `run-${index}`, source, command: 'true', cwd: '/isolated',
    status: 'success', output: '', exitCode: 0 }
}

test('Run messages reject executable renderer fields and malformed source identity', () => {
  const start = { type: 'inline-command.start', requestId: 'request', generation: 'generation', source }
  expect(inlineCommandMessageSchema.safeParse(start).success).toBe(true)
  expect(inlineCommandMessageSchema.safeParse({ ...start, command: 'rm something' }).success).toBe(false)
  expect(inlineCommandMessageSchema.safeParse({ ...start, source: { ...source, cwd: '/other' } }).success).toBe(false)
  for (const value of [-1, 0.5, Infinity, '0', null]) {
    expect(inlineCommandMessageSchema.safeParse({ ...start, source: { ...source, fenceOrdinal: value } }).success).toBe(false)
  }
  expect(inlineCommandMessageSchema.safeParse({ ...start, requestId: 'x'.repeat(129) }).success).toBe(false)
  expect(inlineCommandMessageSchema.safeParse({ type: 'inline-command.get', requestId: 'read' }).success).toBe(true)
  expect(inlineCommandMessageSchema.safeParse({ type: 'inline-command.stop', requestId: 'stop', generation: 'generation', runId: 'run' }).success).toBe(true)
  expect(inlineCommandMessageSchema.safeParse({ type: 'inline-command.stop', requestId: 'stop', generation: 'generation', runId: 'run', signal: 'SIGKILL' }).success).toBe(false)
})

test('accepted start retries never become executable after preview retirement', () => {
  const requests = new InlineCommandRequests()
  expect(requests.admit('first', source)).toBe('new')
  requests.update('first', run(0))
  for (let index = 1; index <= 20; index++) {
    requests.admit(`request-${index}`, { ...source, fenceOrdinal: index })
    requests.update(`request-${index}`, run(index))
  }
  expect(requests.getRuns()).toHaveLength(16)
  expect(requests.getRuns().some(value => value.runId === 'run-0')).toBe(false)
  expect(requests.admit('first', source)).toBe('retry')
  expect(requests.getRequests()[0]).toMatchObject({ requestId: 'first', status: 'completed', runId: 'run-0' })
  expect(() => requests.admit('first', { ...source, fenceOrdinal: 1 })).toThrow('different code block')
})

test('bounded retry cache refuses new admissions instead of evicting accepted keys', () => {
  const requests = new InlineCommandRequests()
  for (let index = 0; index < 128; index++) requests.admit(`request-${index}`, source)
  expect(() => requests.admit('overflow', source)).toThrow('limit')
  expect(requests.admit('request-0', source)).toBe('retry')
})

test('conversation edits retire raw previews without forgetting completed admissions', () => {
  const requests = new InlineCommandRequests()
  requests.admit('first', source)
  requests.update('first', { ...run(0), output: 'removed private output' })
  requests.retirePreviews()
  expect(requests.getRuns()).toEqual([])
  expect(requests.getRequests()).toEqual([
    { requestId: 'first', source, status: 'completed', runId: 'run-0' },
  ])
  expect(requests.admit('first', source)).toBe('retry')
})

test('outcomes belong to the exact request even for the same fence', () => {
  const requests = new InlineCommandRequests()
  requests.admit('first', source)
  requests.update('first', run(0))
  requests.admit('second', source)
  requests.reject('second', 'Source unavailable.')
  expect(requests.getRequests()).toMatchObject([
    { requestId: 'first', status: 'completed', runId: 'run-0' },
    { requestId: 'second', status: 'rejected', error: 'Source unavailable.' },
  ])
  requests.reject('first', 'Agent response failed.')
  expect(requests.getRequests()[0]).toMatchObject({ status: 'rejected', runId: 'run-0', error: 'Agent response failed.' })
})
