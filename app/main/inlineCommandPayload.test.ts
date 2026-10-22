import { expect, test } from 'bun:test'
import { parseInlineCommandPayload } from './inlineCommandPayload.js'

const source = { engineSessionId: 'engine', messageUuid: 'message', contentBlockIndex: 0, fenceOrdinal: 1 }
const start = { type: 'inline-command.start' as const, requestId: 'request', generation: 'generation', source }

test('accepts only the fixed inline command verb shapes', () => {
  for (const verb of [start,
    { type: 'inline-command.stop' as const, requestId: 'request', generation: 'generation', runId: 'run' },
    { type: 'inline-command.get' as const, requestId: 'request' },
  ]) {
    const payload = { sessionId: 'app', verb }
    expect(parseInlineCommandPayload(payload, verb.type)).toEqual(payload)
    expect(parseInlineCommandPayload({ ...payload, cwd: '/tmp' }, verb.type)).toBeNull()
    expect(parseInlineCommandPayload({ ...payload, verb: { ...verb, command: 'echo bad' } }, verb.type)).toBeNull()
  }
})

test('rejects foreign verbs, missing authority and malformed source identities', () => {
  const parse = (verb: unknown) => parseInlineCommandPayload({ sessionId: 'app', verb }, 'inline-command.start')
  expect(parse({ ...start, type: 'inline-command.get' })).toBeNull()
  expect(parse({ ...start, generation: '' })).toBeNull()
  expect(parse({ ...start, requestId: '' })).toBeNull()
  for (const invalid of [null, [], { ...source, cwd: '/tmp' }, { ...source, engineSessionId: '' },
    { ...source, contentBlockIndex: -1 }, { ...source, fenceOrdinal: 0.5 }, { ...source, fenceOrdinal: Infinity }]) {
    expect(parse({ ...start, source: invalid })).toBeNull()
  }
})
